import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ChatsManifestChat } from "./chats-manifest.js";
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
  runMetadataSqlOnShadowDb,
  runWalCheckpointFull,
} from "./sync-engine-ops.js";
import { parseSyncManifestJson, resolveLandingAssetPath } from "./sync-manifest.js";
import {
  PENDING_BUNDLE_SCHEMA,
  type PendingStateBundleV1,
} from "./state-reconciliation.js";
import {
  buildComposerHeaderPayloadsFromSyncChatHistory,
  validateWorkspaceKeysForImport,
} from "./chat-id-sync.js";

const { resolveChatsRoot, runSqliteScript } = __chatPersistenceInternals;

const MANIFEST_FILE = "sync-manifest.json";

export interface SyncEngineDeps {
  /** Extension globalStorage root for pending bundle output */
  globalStorageFsPath: string;
  /** Optional bundled golden template when landing-zone template is unusable */
  bundledGoldenTemplatePath?: string;
}

export interface SyncEnginePrepareSuccess {
  ok: true;
  runId: string;
  pendingBundlePath: string;
  warnings: string[];
}

export interface SyncEnginePrepareFailure {
  ok: false;
  errors: string[];
  warnings: string[];
}

export type SyncEnginePrepareResult = SyncEnginePrepareSuccess | SyncEnginePrepareFailure;

function pendingBundleFile(deps: SyncEngineDeps): string {
  return path.join(deps.globalStorageFsPath, "state-reconciliation", "pending-state-bundle.json");
}

function pendingRunDir(deps: SyncEngineDeps, runId: string): string {
  return path.join(deps.globalStorageFsPath, "state-reconciliation", "runs", runId);
}

/**
 * Source-agnostic sync orchestration: reads a landing zone (sync-manifest.json + assets),
 * performs shadow copy → inject → pending bundle for atomic finalize.
 * Callers supply a landing directory; fetchers (Gist, HTTP, local) populate it identically.
 */
export class SyncEngine {
  constructor(private readonly landingZoneAbsolutePath: string) {}

  async prepare(deps: SyncEngineDeps): Promise<SyncEnginePrepareResult> {
    const logger = getLogger();
    const warnings: string[] = [];
    const manifestPath = path.join(this.landingZoneAbsolutePath, MANIFEST_FILE);
    let raw: string;
    try {
      raw = await fs.readFile(manifestPath, "utf-8");
    } catch (e) {
      return {
        ok: false,
        errors: [`Missing or unreadable ${MANIFEST_FILE}: ${e instanceof Error ? e.message : String(e)}`],
        warnings,
      };
    }

    const parsed = parseSyncManifestJson(raw, this.landingZoneAbsolutePath);
    if (!parsed.ok) {
      return { ok: false, errors: parsed.errors, warnings };
    }

    const manifest = parsed.manifest;
    const liveStatePath = await resolveLiveStateDbPath({
      stateTarget: manifest.state_target,
      workspaceStorageFolderId: manifest.workspace_storage_folder_id,
    });
    if (!liveStatePath) {
      return {
        ok: false,
        errors: [
          "state.vscdb not found for state_target. Open Cursor once or verify workspace_storage_folder_id.",
        ],
        warnings,
      };
    }

    const templateFromLanding = resolveLandingAssetPath(
      this.landingZoneAbsolutePath,
      manifest.db_template.sqlite_file
    );
    let effectiveTemplatePath = templateFromLanding;
    try {
      await fs.access(templateFromLanding);
    } catch {
      if (deps.bundledGoldenTemplatePath) {
        effectiveTemplatePath = deps.bundledGoldenTemplatePath;
        warnings.push(
          `Landing db_template not found at ${manifest.db_template.sqlite_file}; using bundled golden template.`
        );
      } else {
        return {
          ok: false,
          errors: [`db_template file not found: ${manifest.db_template.sqlite_file}`],
          warnings,
        };
      }
    }

    const wsKeys = [...new Set(manifest.chat_history.map((e) => e.workspace_key))];
    const wsCheck = await validateWorkspaceKeysForImport(wsKeys);
    if (!wsCheck.ok) {
      return {
        ok: false,
        errors: [wsCheck.message ?? "workspace_key validation failed"],
        warnings,
      };
    }
    if (wsCheck.message) {
      warnings.push(wsCheck.message);
    }

    const runId = crypto.randomUUID();
    const runDir = pendingRunDir(deps, runId);
    const shadowDir = path.join(runDir, "shadow");
    const shadowMain = path.join(shadowDir, "state.vscdb");

    try {
      await fs.mkdir(shadowDir, { recursive: true });
      await copyStateDbTriple(liveStatePath, shadowDir);
    } catch (e) {
      logger.appendLine(
        `[${new Date().toISOString()}] SyncEngine shadow copy failed: ${e instanceof Error ? e.message : String(e)}`
      );
      return {
        ok: false,
        errors: [`Shadow copy failed: ${e instanceof Error ? e.message : String(e)}`],
        warnings,
      };
    }

    try {
      await runWalCheckpointFull(shadowMain);
    } catch (e) {
      warnings.push(
        `WAL checkpoint on shadow failed: ${e instanceof Error ? e.message : String(e)}. Quit Cursor before finalize.`
      );
    }

    const meta = manifest.metadata_overrides;
    if (meta.state_vscdb_sql && meta.state_vscdb_sql.length > 0) {
      try {
        await runMetadataSqlOnShadowDb(shadowMain, meta.state_vscdb_sql);
      } catch (e) {
        await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
        return {
          ok: false,
          errors: [`metadata_overrides.state_vscdb_sql failed: ${e instanceof Error ? e.message : String(e)}`],
          warnings,
        };
      }
    }

    const autoHeaderPayloads = buildComposerHeaderPayloadsFromSyncChatHistory(manifest.chat_history);
    const userHeaderPayloads = meta.composer_header_payloads ?? [];
    try {
      await mergeComposerHeadersIntoDb(shadowMain, [...userHeaderPayloads, ...autoHeaderPayloads]);
    } catch (e) {
      await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
      return {
        ok: false,
        errors: [`composer.composerHeaders merge failed: ${e instanceof Error ? e.message : String(e)}`],
        warnings,
      };
    }

    const chatsRoot = resolveChatsRoot();
    const storeReplacements: Array<{ livePath: string; shadowPath: string }> = [];

    for (const entry of manifest.chat_history) {
      const shadowStore = path.join(
        runDir,
        "chats",
        entry.workspace_key,
        entry.conversation_id,
        "store.db"
      );
      const liveStore = path.join(
        chatsRoot,
        entry.workspace_key,
        entry.conversation_id,
        "store.db"
      );

      if (entry.store_db_file) {
        const src = resolveLandingAssetPath(this.landingZoneAbsolutePath, entry.store_db_file);
        try {
          await fs.mkdir(path.dirname(shadowStore), { recursive: true });
          await fs.copyFile(src, shadowStore);
        } catch (e) {
          await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
          return {
            ok: false,
            errors: [`chat_history copy failed (${entry.conversation_id}): ${e instanceof Error ? e.message : String(e)}`],
            warnings,
          };
        }
        storeReplacements.push({ livePath: liveStore, shadowPath: shadowStore });
        continue;
      }

      if (entry.inline) {
        const chat: ChatsManifestChat = {
          chat_id: entry.conversation_id,
          title: entry.inline.title,
          content: entry.inline.content,
          timestamp: entry.inline.timestamp,
        };
        try {
          await fs.mkdir(path.dirname(shadowStore), { recursive: true });
          const hw = await hydrateGoldenStoreTemplate({
            templatePath: effectiveTemplatePath,
            outputPath: shadowStore,
            chat,
          });
          warnings.push(...hw.warnings);
          if (manifest.db_template.pre_hydrate_sql) {
            await runSqliteScript(shadowStore, manifest.db_template.pre_hydrate_sql);
          }
        } catch (e) {
          await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
          return {
            ok: false,
            errors: [
              `Hydrate failed for ${entry.conversation_id}: ${e instanceof Error ? e.message : String(e)}`,
            ],
            warnings,
          };
        }
        storeReplacements.push({ livePath: liveStore, shadowPath: shadowStore });
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

    const bundleDir = path.dirname(pendingBundleFile(deps));
    await fs.mkdir(bundleDir, { recursive: true });
    await fs.writeFile(pendingBundleFile(deps), JSON.stringify(bundle, null, 2), "utf-8");
    await fs.writeFile(path.join(runDir, "bundle.json"), JSON.stringify(bundle, null, 2), "utf-8");

    return {
      ok: true,
      runId,
      pendingBundlePath: pendingBundleFile(deps),
      warnings,
    };
  }
}

/** VS Code helper: build deps from extension context and bundled golden path. */
export function syncEngineDepsFromContext(
  context: vscode.ExtensionContext,
  bundledGoldenUri?: vscode.Uri
): SyncEngineDeps {
  const golden =
    bundledGoldenUri?.fsPath ??
    vscode.Uri.joinPath(context.extensionUri, "resources", "golden-chat-store.template.db").fsPath;
  return {
    globalStorageFsPath: context.globalStorageUri.fsPath,
    bundledGoldenTemplatePath: golden,
  };
}

export async function executePrepareSyncFromLandingZone(
  context: vscode.ExtensionContext
): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Select landing zone folder",
  });
  if (!picked?.[0]) {
    return;
  }
  const engine = new SyncEngine(picked[0].fsPath);
  const deps = syncEngineDepsFromContext(context);
  const result = await engine.prepare(deps);
  if (!result.ok) {
    await vscode.window.showErrorMessage(`SyncEngine: ${result.errors.join("; ")}`);
    return;
  }
  const msg =
    `Prepared sync from landing zone (run ${result.runId.slice(0, 8)}). ` +
    `Fully quit Cursor (all windows), reopen, then run “Finalize Pending State Reconciliation”.`;
  await vscode.window.showInformationMessage(msg);
  if (result.warnings.length > 0) {
    await vscode.window.showWarningMessage(result.warnings[0] ?? "Sync warnings.");
  }
}
