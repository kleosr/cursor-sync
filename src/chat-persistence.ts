import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { getLogger } from "./diagnostics.js";
import { createBackup, rollbackFromBackup, pruneOldBackups } from "./rollback.js";
import { __chatPersistenceInternals } from "./transcripts.js";
import {
  computeArtifactChecksum,
  encodeTranscriptArtifact,
  decodeTranscriptArtifact,
  summarizeTranscriptForSidebar,
  type TranscriptBundleArtifactEncoding,
} from "./transcript-bundle.js";

const {
  querySqliteRows,
  runSqliteScript,
  resolveStateDbCandidates,
  resolveChatsRoot,
  findStoreDbForConversation,
  escapeSqlLiteral,
  mergeComposerHeadersChain,
  mergeComposerDataAdditive,
  deriveComposerHeadersPayloadFromSidebarSnapshot,
  isExecFileTimeoutError,
} = __chatPersistenceInternals;

/** Schema for locally-persisted chat bundle. */
export interface ChatBundle {
  schemaVersion: 1;
  type: "chat-persistence";
  createdAt: string;
  conversationId: string;
  title: string;
  subtitle: string;
  previewText: string;
  sidebarSnapshot: Record<string, unknown> | null;
  storeSnapshot: {
    content: string;
    encoding: TranscriptBundleArtifactEncoding;
    checksum: string;
    sizeBytes: number;
    sourceWorkspaceKey: string;
  } | null;
  transcriptFiles: Array<{
    relativePath: string;
    content: string;
    encoding?: TranscriptBundleArtifactEncoding;
    checksum: string;
    sizeBytes: number;
  }>;
}

export interface SaveChatResult {
  bundlePath: string;
  conversationId: string;
  title: string;
  warnings: string[];
}

export interface LoadChatResult {
  conversationId: string;
  transcriptsWritten: number;
  storeWritten: boolean;
  sidebarMerged: boolean;
  warnings: string[];
}

const SQLITE_READ_RETRIES = 3;

/**
 * Save a chat conversation to a local JSON bundle file.
 * Collects: store.db snapshot, sidebar metadata from state.vscdb, and transcript JSONL files.
 */
export async function executeSaveChatLocal(
  context: vscode.ExtensionContext
): Promise<void> {
  const logger = getLogger();

  const conversationId = await vscode.window.showInputBox({
    prompt: "Enter the conversation ID (folder name under agent-transcripts or chats)",
    placeHolder: "e.g. abc123-def456-...",
    ignoreFocusOut: true,
  });

  if (!conversationId || conversationId.trim().length === 0) {
    return;
  }

  const trimmedId = conversationId.trim();

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Saving chat locally...",
      cancellable: false,
    },
    async (progress) => {
      try {
        const result = await saveChat(context, trimmedId, progress);

        let msg = `Chat "${result.title}" saved to ${path.basename(result.bundlePath)}`;
        if (result.warnings.length > 0) {
          msg += ` (${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"})`;
        }
        vscode.window.showInformationMessage(msg);

        for (const w of result.warnings) {
          logger.appendLine(`[${new Date().toISOString()}] [chat-save] ${w}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.appendLine(`[${new Date().toISOString()}] [chat-save] FAILED: ${msg}`);
        vscode.window.showErrorMessage(`Chat save failed: ${msg}`);
      }
    }
  );
}

/**
 * Load a chat from a local JSON bundle file.
 * Restores: store.db, sidebar metadata into state.vscdb, and transcript JSONL files.
 */
export async function executeLoadChatLocal(
  context: vscode.ExtensionContext
): Promise<void> {
  const logger = getLogger();

  const uris = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: { "Chat Bundle": ["json"] },
    title: "Select chat bundle to load",
  });

  if (!uris || uris.length === 0) {
    return;
  }

  const bundlePath = uris[0]!.fsPath;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Loading chat from bundle...",
      cancellable: false,
    },
    async (progress) => {
      try {
        const result = await loadChat(context, bundlePath, progress);

        const parts: string[] = [`Chat "${result.conversationId}" loaded.`];
        if (result.transcriptsWritten > 0) {
          parts.push(`${result.transcriptsWritten} transcript file${result.transcriptsWritten === 1 ? "" : "s"}`);
        }
        if (result.storeWritten) {
          parts.push("store.db restored");
        }
        if (result.sidebarMerged) {
          parts.push("sidebar merged");
        }
        if (result.warnings.length > 0) {
          parts.push(`${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}`);
        }

        vscode.window.showInformationMessage(parts.join(" | "));

        const config = vscode.workspace.getConfiguration("cursorSync");
        const autoReload = config.get<boolean>("transcripts.autoReloadAfterImport") ?? false;
        if (autoReload) {
          await vscode.commands.executeCommand("workbench.action.reloadWindow");
        } else {
          const reloadAction = "Reload Window";
          const choice = await vscode.window.showInformationMessage(
            "Cursor may need a reload to reflect imported chat in the sidebar.",
            reloadAction
          );
          if (choice === reloadAction) {
            vscode.commands.executeCommand("workbench.action.reloadWindow");
          }
        }

        for (const w of result.warnings) {
          logger.appendLine(`[${new Date().toISOString()}] [chat-load] ${w}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.appendLine(`[${new Date().toISOString()}] [chat-load] FAILED: ${msg}`);
        vscode.window.showErrorMessage(`Chat load failed: ${msg}`);
      }
    }
  );
}

async function saveChat(
  context: vscode.ExtensionContext,
  conversationId: string,
  progress: vscode.Progress<{ message?: string; increment?: number }>
): Promise<SaveChatResult> {
  const warnings: string[] = [];

  progress.report({ message: "Locating store.db..." });
  let storeSnapshot: ChatBundle["storeSnapshot"] = null;
  const storeInfo = await findStoreDbForConversation(conversationId);
  if (storeInfo) {
    const raw = await fs.readFile(storeInfo.absolutePath);
    const checksum = computeArtifactChecksum(raw);
    storeSnapshot = {
      content: raw.toString("base64"),
      encoding: "base64",
      checksum,
      sizeBytes: raw.length,
      sourceWorkspaceKey: storeInfo.workspaceKey,
    };
  } else {
    warnings.push(`store.db not found for conversation ${conversationId}; only transcripts will be saved.`);
  }

  progress.report({ message: "Reading sidebar metadata from state.vscdb..." });
  let sidebarSnapshot: Record<string, unknown> | null = null;
  const stateDbPaths = await resolveStateDbCandidates();
  if (stateDbPaths.length > 0) {
    try {
      const rows = await querySqliteRows(
        stateDbPaths[0]!,
        `SELECT key, value FROM ItemTable WHERE key IN ('composer.composerHeaders', 'composer.composerData');`,
        { retries: SQLITE_READ_RETRIES }
      );
      if (rows.length > 0) {
        const snapshot: Record<string, unknown> = { conversationId };
        for (const row of rows) {
          const key = String(row.key ?? "");
          const value = row.value;
          if (key === "composer.composerHeaders" || key === "composer.composerData") {
            snapshot[key.replace("composer.", "")] = typeof value === "string" ? safeJsonParse(value) : value;
          }
        }
        sidebarSnapshot = snapshot;
      }
    } catch (err) {
      const isTimeout = isExecFileTimeoutError(err);
      warnings.push(
        isTimeout
          ? "state.vscdb timed out (database may be locked); sidebar metadata skipped."
          : `state.vscdb read failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else {
    warnings.push("state.vscdb not found; sidebar metadata skipped.");
  }

  progress.report({ message: "Collecting transcript files..." });
  const transcriptFiles: ChatBundle["transcriptFiles"] = [];
  const projectsRoot = resolveProjectsRoot();
  try {
    const projectDirs = await fs.readdir(projectsRoot, { withFileTypes: true });
    for (const dir of projectDirs) {
      if (!dir.isDirectory()) {
        continue;
      }
      const transcriptDir = path.join(projectsRoot, dir.name, "agent-transcripts", conversationId);
      let files: string[];
      try {
        files = await fs.readdir(transcriptDir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith(".jsonl")) {
          continue;
        }
        const absPath = path.join(transcriptDir, file);
        const raw = await fs.readFile(absPath);
        const checksum = computeArtifactChecksum(raw);
        const encoded = encodeTranscriptArtifact(raw);
        transcriptFiles.push({
          relativePath: `${dir.name}/agent-transcripts/${conversationId}/${file}`,
          content: encoded.content,
          encoding: encoded.encoding,
          checksum,
          sizeBytes: raw.length,
        });
      }
    }
  } catch {
    warnings.push("Could not enumerate transcript project directories.");
  }

  if (transcriptFiles.length === 0 && !storeSnapshot) {
    throw new Error(`No data found for conversation ${conversationId}. Check the ID and try again.`);
  }

  // Derive title from transcript content or fallback to ID
  let title = conversationId;
  if (transcriptFiles.length > 0) {
    const firstContent = decodeTranscriptArtifact(
      transcriptFiles[0]!.content,
      transcriptFiles[0]!.encoding
    ).toString("utf-8");
    const summary = summarizeTranscriptForSidebar(firstContent, conversationId);
    title = summary.title;
  }

  const bundle: ChatBundle = {
    schemaVersion: 1,
    type: "chat-persistence",
    createdAt: new Date().toISOString(),
    conversationId,
    title,
    subtitle: `${transcriptFiles.length} file${transcriptFiles.length === 1 ? "" : "s"}`,
    previewText: title,
    sidebarSnapshot,
    storeSnapshot,
    transcriptFiles,
  };

  progress.report({ message: "Writing bundle..." });
  const safeName = conversationId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const bundlePath = path.join(
    context.globalStorageUri.fsPath,
    "chat-bundles",
    `${safeName}_${timestamp}.json`
  );
  await fs.mkdir(path.dirname(bundlePath), { recursive: true });
  await fs.writeFile(bundlePath, JSON.stringify(bundle, null, 2), "utf-8");

  return { bundlePath, conversationId, title, warnings };
}

async function loadChat(
  context: vscode.ExtensionContext,
  bundlePath: string,
  progress: vscode.Progress<{ message?: string; increment?: number }>
): Promise<LoadChatResult> {
  const warnings: string[] = [];

  progress.report({ message: "Reading bundle..." });
  const raw = await fs.readFile(bundlePath, "utf-8");
  const bundle = JSON.parse(raw) as ChatBundle;

  if (bundle.type !== "chat-persistence" || bundle.schemaVersion !== 1) {
    throw new Error("Invalid or unsupported chat bundle format.");
  }

  const conversationId = bundle.conversationId;
  let transcriptsWritten = 0;
  let storeWritten = false;
  let sidebarMerged = false;

  // Collect unique source project keys from transcript relative paths
  const sourceProjectKeys = new Set<string>();
  for (const tf of bundle.transcriptFiles) {
    const segments = tf.relativePath.split("/");
    if (segments.length > 0) {
      sourceProjectKeys.add(segments[0]!);
    }
  }

  // Build project mapping: source project key -> target project folder name
  const projectMapping: Map<string, string> = new Map();
  if (sourceProjectKeys.size > 0 && bundle.transcriptFiles.length > 0) {
    progress.report({ message: "Mapping projects..." });
    const mapping = await promptForTargetProject([...sourceProjectKeys].sort());
    if (mapping === null) {
      return { conversationId, transcriptsWritten: 0, storeWritten: false, sidebarMerged: false, warnings: ["Cancelled by user."] };
    }
    for (const [k, v] of mapping) {
      projectMapping.set(k, v);
    }
  }

  // Build workspace mapping for store.db: source workspace key -> target workspace key
  let targetWorkspaceKey: string | undefined;
  if (bundle.storeSnapshot) {
    const chatsRoot = resolveChatsRoot();
    const sourceKey = bundle.storeSnapshot.sourceWorkspaceKey;
    const localWorkspaces = await listChatsWorkspaceDirs(chatsRoot);

    if (localWorkspaces.length === 0) {
      warnings.push("No local chat workspaces found in ~/.cursor/chats/. store.db restore skipped.");
    } else if (localWorkspaces.length === 1) {
      targetWorkspaceKey = localWorkspaces[0]!.name;
    } else {
      progress.report({ message: "Selecting target workspace..." });
      const picked = await promptForTargetWorkspace(sourceKey, localWorkspaces);
      if (picked === null) {
        return { conversationId, transcriptsWritten: 0, storeWritten: false, sidebarMerged: false, warnings: ["Cancelled by user."] };
      }
      targetWorkspaceKey = picked;
    }
  }

  // Restore transcript JSONL files (remapped to target project)
  if (bundle.transcriptFiles.length > 0) {
    progress.report({ message: "Restoring transcript files..." });
    const projectsRoot = resolveProjectsRoot();
    for (const tf of bundle.transcriptFiles) {
      const decoded = decodeTranscriptArtifact(tf.content, tf.encoding);

      const actualChecksum = computeArtifactChecksum(decoded);
      if (actualChecksum !== tf.checksum) {
        warnings.push(`Checksum mismatch for ${tf.relativePath}; skipped.`);
        continue;
      }

      // Remap source project key to target project folder
      const segments = tf.relativePath.split("/");
      const sourceKey = segments[0]!;
      const mappedKey = projectMapping.get(sourceKey) ?? sourceKey;
      const remappedPath = [mappedKey, ...segments.slice(1)].join("/");
      const targetPath = path.join(projectsRoot, remappedPath);

      await fs.mkdir(path.dirname(targetPath), { recursive: true });

      const { entries: backupEntries } = await createBackup(context, [targetPath]);
      try {
        await fs.writeFile(targetPath, decoded);
        transcriptsWritten += 1;
      } catch (err) {
        await rollbackFromBackup(backupEntries);
        warnings.push(`Failed to write ${remappedPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Restore store.db (remapped to target workspace)
  if (bundle.storeSnapshot && targetWorkspaceKey) {
    progress.report({ message: "Restoring store.db..." });
    const snap = bundle.storeSnapshot;
    const decoded = decodeTranscriptArtifact(snap.content, snap.encoding);

    const actualChecksum = computeArtifactChecksum(decoded);
    if (actualChecksum !== snap.checksum) {
      warnings.push("store.db checksum mismatch; skipped.");
    } else {
      const chatsRoot = resolveChatsRoot();
      const storeDbPath = path.join(chatsRoot, targetWorkspaceKey, conversationId, "store.db");
      await fs.mkdir(path.dirname(storeDbPath), { recursive: true });

      const { entries: backupEntries } = await createBackup(context, [storeDbPath]);
      try {
        await fs.writeFile(storeDbPath, decoded);
        storeWritten = true;
      } catch (err) {
        await rollbackFromBackup(backupEntries);
        warnings.push(`Failed to write store.db: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Merge sidebar metadata into state.vscdb
  if (bundle.sidebarSnapshot) {
    progress.report({ message: "Merging sidebar state..." });
    const stateDbPaths = await resolveStateDbCandidates();

    if (stateDbPaths.length === 0) {
      warnings.push("state.vscdb not found; sidebar merge skipped.");
    } else {
      const dbPath = stateDbPaths[0]!;
      try {
        const rows = await querySqliteRows(
          dbPath,
          "SELECT key, value FROM ItemTable WHERE key IN ('composer.composerHeaders', 'composer.composerData');",
          { retries: SQLITE_READ_RETRIES }
        );

        let existingHeadersRaw: string | undefined;
        let existingDataRaw: string | undefined;
        for (const row of rows) {
          const key = String(row.key ?? "");
          const value = row.value;
          if (key === "composer.composerHeaders") {
            existingHeadersRaw = typeof value === "string" ? value : JSON.stringify(value);
          }
          if (key === "composer.composerData") {
            existingDataRaw = typeof value === "string" ? value : JSON.stringify(value);
          }
        }

        // Build import payload from the sidebar snapshot
        const snap = bundle.sidebarSnapshot;
        const headersPayload = snap.composerHeaders
          ? (snap.composerHeaders as Record<string, unknown>)
          : deriveComposerHeadersPayloadFromSidebarSnapshot({
              ...snap,
              title: bundle.title,
              lastUpdatedAt: bundle.createdAt,
            });

        const dataPayload = snap.composerData
          ? (snap.composerData as Record<string, unknown>)
          : undefined;

        const scriptParts: string[] = ["BEGIN IMMEDIATE;"];

        if (headersPayload) {
          const merged = mergeComposerHeadersChain(existingHeadersRaw, [headersPayload]);
          const escaped = escapeSqlLiteral(JSON.stringify(merged));
          scriptParts.push(
            `UPDATE ItemTable SET value = '${escaped}' WHERE key = 'composer.composerHeaders';`,
            `INSERT INTO ItemTable (key, value) SELECT 'composer.composerHeaders', '${escaped}' WHERE NOT EXISTS (SELECT 1 FROM ItemTable WHERE key = 'composer.composerHeaders');`
          );
        }

        if (dataPayload) {
          const merged = mergeComposerDataAdditive(existingDataRaw, [dataPayload]);
          const escaped = escapeSqlLiteral(JSON.stringify(merged));
          scriptParts.push(
            `UPDATE ItemTable SET value = '${escaped}' WHERE key = 'composer.composerData';`,
            `INSERT INTO ItemTable (key, value) SELECT 'composer.composerData', '${escaped}' WHERE NOT EXISTS (SELECT 1 FROM ItemTable WHERE key = 'composer.composerData');`
          );
        }

        scriptParts.push("COMMIT;");

        if (scriptParts.length > 2) {
          const { entries: backupEntries } = await createBackup(context, [dbPath]);
          try {
            await runSqliteScript(dbPath, scriptParts.join("\n") + "\n");
            sidebarMerged = true;
          } catch (err) {
            await rollbackFromBackup(backupEntries);
            warnings.push(`state.vscdb write failed: ${err instanceof Error ? err.message : String(err)}; rolled back.`);
          }
        }
      } catch (err) {
        const isTimeout = isExecFileTimeoutError(err);
        warnings.push(
          isTimeout
            ? "state.vscdb timed out (database may be locked); sidebar merge skipped."
            : `state.vscdb read failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  await pruneOldBackups(context);

  return { conversationId, transcriptsWritten, storeWritten, sidebarMerged, warnings };
}

function resolveProjectsRoot(): string {
  return path.join(os.homedir(), ".cursor", "projects");
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

interface WorkspaceDir {
  name: string;
  fullPath: string;
}

async function listChatsWorkspaceDirs(chatsRoot: string): Promise<WorkspaceDir[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(chatsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, fullPath: path.join(chatsRoot, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function humanWorkspaceLabel(folderName: string): string {
  const parts = folderName.split("-");
  if (parts.length <= 1) return folderName;
  const last = parts[parts.length - 1]!;
  const withoutHash = last.length === 40 || last.length === 8 ? parts.slice(0, -1) : parts;
  return withoutHash.join("-");
}

async function promptForTargetProject(sourceProjectKeys: string[]): Promise<Map<string, string> | null> {
  const projectsRoot = resolveProjectsRoot();
  let projectDirs: import("node:fs").Dirent[];
  try {
    projectDirs = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    vscode.window.showErrorMessage(
      `Cannot read projects directory: ${projectsRoot}. Open a project in Cursor first.`
    );
    return null;
  }

  const localProjects = projectDirs
    .filter((d) => d.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  if (localProjects.length === 0) {
    vscode.window.showErrorMessage(
      "No local Cursor projects found. Open a project in Cursor first to create a project directory."
    );
    return null;
  }

  const mapping = new Map<string, string>();

  for (const sourceKey of sourceProjectKeys) {
    const sourceLabel = humanWorkspaceLabel(sourceKey);
    const picks: vscode.QuickPickItem[] = localProjects.map((p) => ({
      label: humanWorkspaceLabel(p.name),
      description: p.name,
      detail: path.join(projectsRoot, p.name),
    }));
    picks.unshift({ label: "(Skip)", description: "skip" });

    const selected = await vscode.window.showQuickPick(picks, {
      title: `Map source project "${sourceLabel}" to a local project`,
      placeHolder: `Select the local project to receive chat transcripts from "${sourceLabel}"`,
    });

    if (!selected) {
      return null;
    }

    if (selected.description === "skip") {
      continue;
    }

    mapping.set(sourceKey, selected.description!);
  }

  return mapping;
}

async function promptForTargetWorkspace(
  sourceWorkspaceKey: string | undefined,
  localWorkspaces: WorkspaceDir[]
): Promise<string | null> {
  const sourceLabel = sourceWorkspaceKey ? humanWorkspaceLabel(sourceWorkspaceKey) : "unknown";

  const picks: vscode.QuickPickItem[] = localWorkspaces.map((w) => ({
    label: humanWorkspaceLabel(w.name),
    description: w.name,
    detail: w.fullPath,
  }));

  const selected = await vscode.window.showQuickPick(picks, {
    title: `Select target workspace for store.db (source: "${sourceLabel}")`,
    placeHolder: "Choose the local workspace where chat data should be restored",
  });

  if (!selected) {
    return null;
  }

  return selected.description!;
}
