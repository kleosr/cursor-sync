import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { manifestToHeaderPayloads, parseChatsManifestJson } from "./chats-manifest.js";
import { createBackup, rollbackFromBackup } from "./rollback.js";
import { getLogger } from "./diagnostics.js";
import {
  GOLDEN_STORE_TEMPLATE_VERSION,
  GOLDEN_TEMPLATE_CAPTURED_FOR_CURSOR,
  hydrateGoldenStoreTemplate,
} from "./store-template-hydrate.js";
import { __chatPersistenceInternals } from "./transcripts.js";
import {
  copyStateDbTriple,
  mergeComposerHeadersIntoDb,
  resolveLiveStateDbPath,
  runWalCheckpointFull,
} from "./sync-engine-ops.js";
import { validateWorkspaceKeysForImport } from "./chat-id-sync.js";

const { resolveChatsRoot } = __chatPersistenceInternals;

export const PENDING_BUNDLE_SCHEMA = 1 as const;
const PENDING_BUNDLE_FILE = "pending-state-bundle.json";

export interface PendingStateBundleV1 {
  schemaVersion: typeof PENDING_BUNDLE_SCHEMA;
  runId: string;
  createdAt: string;
  goldenStoreTemplateVersion: number;
  goldenTemplateNote: string;
  stateVscdbLive: string;
  stateVscdbShadow: string;
  storeReplacements: Array<{ livePath: string; shadowPath: string }>;
}

function pendingBundlePath(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, "state-reconciliation", PENDING_BUNDLE_FILE);
}

function pendingRunDir(context: vscode.ExtensionContext, runId: string): string {
  return path.join(context.globalStorageUri.fsPath, "state-reconciliation", "runs", runId);
}

async function replaceFileWithRetries(
  source: string,
  dest: string,
  opts?: { retries?: number; delayMs?: number }
): Promise<void> {
  const retries = opts?.retries ?? 5;
  const delayMs = opts?.delayMs ?? 400;
  let last: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      await fs.copyFile(source, dest);
      return;
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw last;
}

async function removeIfExists(p: string): Promise<void> {
  try {
    await fs.rm(p, { force: true });
  } catch {}
}

export async function hasPendingStateBundle(
  context: vscode.ExtensionContext
): Promise<boolean> {
  try {
    await fs.access(pendingBundlePath(context));
    return true;
  } catch {
    return false;
  }
}

export async function notifyPendingStateBundleIfAny(
  context: vscode.ExtensionContext
): Promise<void> {
  if (await hasPendingStateBundle(context)) {
    void vscode.window.showInformationMessage(
      "Cursor Sync: A pending state reconciliation is waiting. Run “Finalize Pending State Reconciliation” after fully quitting Cursor (all windows)."
    );
  }
}

export async function executePrepareStateReconciliation(
  context: vscode.ExtensionContext
): Promise<void> {
  const logger = getLogger();
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: "Import chats.json",
    filters: { JSON: ["json"] },
  });
  if (!picked?.[0]) {
    return;
  }
  const raw = await fs.readFile(picked[0].fsPath, "utf-8");
  const parsed = parseChatsManifestJson(raw);
  if (!parsed.ok) {
    await vscode.window.showErrorMessage(`Invalid chats manifest: ${parsed.errors.join("; ")}`);
    return;
  }
  const manifest = parsed.manifest;
  const liveStatePath = await resolveLiveStateDbPath({
    stateTarget: manifest.stateTarget,
    workspaceStorageFolderId: manifest.workspaceStorageFolderId,
  });
  if (!liveStatePath) {
    await vscode.window.showErrorMessage(
      "state.vscdb not found for the selected target. Open Cursor once or verify workspaceStorageFolderId."
    );
    return;
  }

  const wsCheck = await validateWorkspaceKeysForImport([manifest.workspaceKey]);
  if (!wsCheck.ok) {
    await vscode.window.showErrorMessage(wsCheck.message ?? "workspace_key invalid.");
    return;
  }
  if (wsCheck.message) {
    await vscode.window.showWarningMessage(wsCheck.message);
  }

  const runId = crypto.randomUUID();
  const runDir = pendingRunDir(context, runId);
  const shadowDir = path.join(runDir, "shadow");
  const templateUri = vscode.Uri.joinPath(
    context.extensionUri,
    "resources",
    "golden-chat-store.template.db"
  );
  const templatePath = templateUri.fsPath;
  try {
    await fs.access(templatePath);
  } catch {
    await vscode.window.showErrorMessage(
      "Golden store template missing from extension resources (golden-chat-store.template.db)."
    );
    return;
  }

  try {
    await fs.mkdir(shadowDir, { recursive: true });
    await copyStateDbTriple(liveStatePath, shadowDir);
  } catch (e) {
    logger.appendLine(
      `[${new Date().toISOString()}] Shadow copy failed: ${e instanceof Error ? e.message : String(e)}`
    );
    await vscode.window.showErrorMessage(
      `Could not copy state.vscdb (is Cursor locking files?). ${e instanceof Error ? e.message : String(e)}`
    );
    return;
  }

  const shadowMain = path.join(shadowDir, "state.vscdb");
  try {
    await runWalCheckpointFull(shadowMain);
  } catch (e) {
    logger.appendLine(
      `[${new Date().toISOString()}] WAL checkpoint on shadow failed: ${e instanceof Error ? e.message : String(e)}`
    );
    await vscode.window.showWarningMessage(
      "Shadow WAL checkpoint failed; continuing. Fully quit Cursor before finalize."
    );
  }

  const headerPayloads = manifestToHeaderPayloads(manifest);
  try {
    await mergeComposerHeadersIntoDb(shadowMain, headerPayloads);
  } catch (e) {
    logger.appendLine(
      `[${new Date().toISOString()}] Composer merge on shadow failed: ${e instanceof Error ? e.message : String(e)}`
    );
    await vscode.window.showErrorMessage(
      `Merge into shadow DB failed: ${e instanceof Error ? e.message : String(e)}`
    );
    await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
    return;
  }

  const storeReplacements: Array<{ livePath: string; shadowPath: string }> = [];
  const chatsRoot = resolveChatsRoot();
  const warnings: string[] = [];

  for (const chat of manifest.chats) {
    const shadowStore = path.join(runDir, "chats", manifest.workspaceKey, chat.chat_id, "store.db");
    const liveStore = path.join(chatsRoot, manifest.workspaceKey, chat.chat_id, "store.db");
    try {
      const hw = await hydrateGoldenStoreTemplate({
        templatePath,
        outputPath: shadowStore,
        chat,
      });
      warnings.push(...hw.warnings);
      storeReplacements.push({ livePath: liveStore, shadowPath: shadowStore });
    } catch (e) {
      await vscode.window.showErrorMessage(
        `Store hydrate failed for ${chat.chat_id}: ${e instanceof Error ? e.message : String(e)}`
      );
      await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
      return;
    }
  }

  const bundle: PendingStateBundleV1 = {
    schemaVersion: PENDING_BUNDLE_SCHEMA,
    runId,
    createdAt: new Date().toISOString(),
    goldenStoreTemplateVersion: GOLDEN_STORE_TEMPLATE_VERSION,
    goldenTemplateNote: GOLDEN_TEMPLATE_CAPTURED_FOR_CURSOR,
    stateVscdbLive: liveStatePath,
    stateVscdbShadow: shadowMain,
    storeReplacements,
  };

  const bundleDir = path.dirname(pendingBundlePath(context));
  await fs.mkdir(bundleDir, { recursive: true });
  await fs.writeFile(pendingBundlePath(context), JSON.stringify(bundle, null, 2), "utf-8");
  await fs.writeFile(path.join(runDir, "bundle.json"), JSON.stringify(bundle, null, 2), "utf-8");

  const msg =
    `Prepared state reconciliation (run ${runId.slice(0, 8)}). ` +
    `Fully quit Cursor (all windows), reopen, then run “Finalize Pending State Reconciliation”.`;
  await vscode.window.showInformationMessage(msg);
  if (warnings.length > 0) {
    await vscode.window.showWarningMessage(warnings[0] ?? "Hydration warnings.");
  }
}

export async function executeFinalizeStateReconciliation(
  context: vscode.ExtensionContext
): Promise<void> {
  const logger = getLogger();
  const bundlePath = pendingBundlePath(context);
  let raw: string;
  try {
    raw = await fs.readFile(bundlePath, "utf-8");
  } catch {
    await vscode.window.showErrorMessage("No pending state bundle. Run prepare import first.");
    return;
  }

  let bundle: PendingStateBundleV1;
  try {
    bundle = JSON.parse(raw) as PendingStateBundleV1;
  } catch {
    await vscode.window.showErrorMessage("Pending bundle is corrupt.");
    return;
  }
  if (bundle.schemaVersion !== PENDING_BUNDLE_SCHEMA) {
    await vscode.window.showErrorMessage("Unsupported pending bundle schema.");
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    "Replace live state.vscdb and chat store files from the pending shadow copies? Backups will be created first.",
    { modal: true },
    "Replace"
  );
  if (confirm !== "Replace") {
    return;
  }

  const backupPaths: string[] = [bundle.stateVscdbLive];
  for (const s of bundle.storeReplacements) {
    backupPaths.push(s.livePath);
  }
  const { entries: backupEntries } = await createBackup(context, backupPaths);

  try {
    await removeIfExists(`${bundle.stateVscdbLive}-wal`);
    await removeIfExists(`${bundle.stateVscdbLive}-shm`);
    await replaceFileWithRetries(bundle.stateVscdbShadow, bundle.stateVscdbLive);

    for (const pair of bundle.storeReplacements) {
      await fs.mkdir(path.dirname(pair.livePath), { recursive: true });
      await replaceFileWithRetries(pair.shadowPath, pair.livePath);
    }
  } catch (e) {
    await rollbackFromBackup(backupEntries);
    logger.appendLine(
      `[${new Date().toISOString()}] Finalize failed: ${e instanceof Error ? e.message : String(e)}`
    );
    await vscode.window.showErrorMessage(
      `Finalize failed (restored backups). Fully quit Cursor and retry. ${e instanceof Error ? e.message : String(e)}`
    );
    return;
  }

  await removeIfExists(bundlePath).catch(() => {});
  await fs
    .rm(path.join(path.dirname(bundlePath), "runs", bundle.runId), { recursive: true, force: true })
    .catch(() => {});

  await vscode.window.showInformationMessage(
    "State reconciliation applied. Reload the window or restart Cursor if chats do not appear."
  );
}
