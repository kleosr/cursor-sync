import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { GistClient } from "./gist.js";
import { requireToken, getToken } from "./auth.js";
import { withRetry } from "./retry.js";
import { getLogger } from "./diagnostics.js";
import { createBackup, pruneOldBackups, rollbackFromBackup } from "./rollback.js";
import type { GistResponse } from "./types.js";
import {
  TRANSCRIPT_MANIFEST_FILE_NAME,
  bundleArtifactSyncKey,
  computeArtifactChecksum,
  computeTranscriptMachineId,
  decodeTranscriptArtifact,
  encodeTranscriptArtifact,
  getConversationIdFromRelativePath,
  getConversationScopedRelativePath,
  gistFileNameToSyncKey,
  isTranscriptManifestV2,
  parseTranscriptBundleManifest,
  summarizeTranscriptForSidebar,
  syncKeyToGistFileName,
  type TranscriptBundleArtifactEntry,
  type TranscriptBundleArtifactKind,
  type TranscriptBundleConversationEntry,
  type TranscriptBundleSourceProjectInfo,
  type TranscriptManifestV1,
  type TranscriptManifestV2,
} from "./transcript-bundle.js";

export interface ProjectInfo {
  folderName: string;
  fullPath: string;
  label: string;
}

export interface TranscriptFileEntry {
  absolutePath: string;
  relativePath: string;
  projectKey: string;
}

const execFile = promisify(execFileCallback);
const execFileWithInput = execFile as (
  command: string,
  args: readonly string[] | undefined,
  options: { input: string; maxBuffer: number; timeout?: number }
) => Promise<{ stdout: string; stderr: string }>;

const SQLITE_SUBPROCESS_TIMEOUT_MS = 20_000;
const FILE_ACCESS_TIMEOUT_MS = 12_000;

function isExecFileTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const e = error as { killed?: boolean; code?: string; message?: string };
  if (e.killed === true) {
    return true;
  }
  if (e.code === "ETIMEDOUT") {
    return true;
  }
  const msg = typeof e.message === "string" ? e.message : "";
  return msg.includes("timed out") || msg.includes("ETIMEDOUT");
}

async function accessPathOutcome(absPath: string): Promise<"exists" | "missing" | "timeout"> {
  let settled = false;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve("timeout");
      }
    }, FILE_ACCESS_TIMEOUT_MS);
    fs.access(absPath)
      .then(() => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve("exists");
      })
      .catch(() => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve("missing");
      });
  });
}

interface ExportConversationState {
  projectKey: string;
  conversationId: string;
  transcriptArtifacts: string[];
  transcriptRelativePaths: string[];
  primaryTranscriptContent: string;
  primaryTranscriptSelectedAt: string;
  lastUpdatedAt: string;
  warnings: string[];
  storeArtifact?: string;
  sourceWorkspaceKey?: string;
}

interface ComposerHeadersPayload {
  allComposers: Array<Record<string, unknown>>;
}

interface ExportProjectAccumulator {
  folderName: string;
  fileCount: number;
  conversationIds: Set<string>;
  artifactCount: number;
}

interface SidebarStateEvidence {
  stateDbPath: string;
  extraction: "state-db-match" | "state-db-unmatched";
  matchedItemTableRows: Array<{ key: string; value: unknown }>;
  matchedCursorDiskRows: Array<{ key: string; value: unknown }>;
  composerSummaryRows: Array<{ key: string; valueLength: number }>;
}

interface RestoreOperation {
  absolutePath: string;
  content: Buffer;
  checksum: string;
  syncKey: string;
  kind: TranscriptBundleArtifactKind;
  conversationId?: string;
}

interface RestorePreview {
  newFiles: RestoreOperation[];
  conflicts: RestoreOperation[];
  unchanged: RestoreOperation[];
}

interface ImportRestoreReport {
  transcriptWritten: number;
  storeWritten: number;
  sidebarWritten: number;
  stateDbMerged: number;
  stateDbSkippedNoPayload: number;
  stateDbSkippedNoDb: number;
  statePartial: boolean;
  warnings: string[];
}

export function resolveProjectsRoot(): string {
  const home = os.homedir();
  return path.join(home, ".cursor", "projects");
}

export async function discoverProjects(
  projectsRoot?: string
): Promise<ProjectInfo[]> {
  const root = projectsRoot ?? resolveProjectsRoot();
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const projects: ProjectInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(root, entry.name);
    projects.push({
      folderName: entry.name,
      fullPath,
      label: humanLabel(entry.name),
    });
  }
  return projects.sort((a, b) => a.label.localeCompare(b.label));
}

function humanLabel(folderName: string): string {
  const parts = folderName.split("-");
  if (parts.length <= 1) return folderName;
  const withoutHash =
    parts[parts.length - 1]?.length === 40 ||
    parts[parts.length - 1]?.length === 8
      ? parts.slice(0, -1)
      : parts;
  return withoutHash.join("-");
}

export async function enumerateTranscriptFiles(
  projectDir: string,
  maxBytes: number
): Promise<TranscriptFileEntry[]> {
  const transcriptsDir = path.join(projectDir, "agent-transcripts");
  const projectKey = path.basename(projectDir);
  const files: TranscriptFileEntry[] = [];

  const allFiles = await walkDir(transcriptsDir);
  for (const absPath of allFiles) {
    if (!absPath.endsWith(".jsonl")) continue;
    try {
      const stat = await fs.stat(absPath);
      if (stat.size > maxBytes) continue;
    } catch {
      continue;
    }
    const rel = path.relative(transcriptsDir, absPath).split(path.sep).join("/");
    files.push({ absolutePath: absPath, relativePath: rel, projectKey });
  }
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function walkDir(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walkDir(fullPath)));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

export async function executeExportTranscripts(
  context: vscode.ExtensionContext
): Promise<void> {
  const logger = getLogger();
  logger.appendLine(`[${new Date().toISOString()}] Transcript export started`);

  const config = vscode.workspace.getConfiguration("cursorSync");
  const enabled = config.get<boolean>("transcripts.enabled") ?? false;
  if (!enabled) {
    const action = await vscode.window.showWarningMessage(
      "Agent transcript sync is not enabled. Enable it now?",
      "Enable",
      "Cancel"
    );
    if (action !== "Enable") return;
    await config.update("transcripts.enabled", true, vscode.ConfigurationTarget.Global);
  }

  const token = await requireToken(context);
  if (!token) return;

  const maxFileSizeKB = config.get<number>("transcripts.maxFileSizeKB") ?? 2048;
  const maxBytes = maxFileSizeKB * 1024;

  const projects = await discoverProjects();
  if (projects.length === 0) {
    vscode.window.showInformationMessage("No Cursor projects found under ~/.cursor/projects/.");
    return;
  }

  const projectPicks: vscode.QuickPickItem[] = projects.map((p) => ({
    label: p.label,
    description: p.folderName,
    picked: false,
  }));

  const selectedProjectItems = await vscode.window.showQuickPick(projectPicks, {
    canPickMany: true,
    title: "Select source projects to export transcripts from",
    placeHolder: "Choose one or more projects",
  });

  if (!selectedProjectItems || selectedProjectItems.length === 0) {
    logger.appendLine(`[${new Date().toISOString()}] Transcript export cancelled: no projects selected`);
    return;
  }

  const selectedProjects = projects.filter((p) =>
    selectedProjectItems.some((item) => item.description === p.folderName)
  );

  const allFiles: TranscriptFileEntry[] = [];
  for (const proj of selectedProjects) {
    const files = await enumerateTranscriptFiles(proj.fullPath, maxBytes);
    allFiles.push(...files);
  }

  if (allFiles.length === 0) {
    vscode.window.showInformationMessage("No transcript files found in the selected projects.");
    return;
  }

  const filePicks: vscode.QuickPickItem[] = allFiles.map((f) => ({
    label: f.relativePath,
    description: f.projectKey,
    picked: true,
  }));

  const selectedFileItems = await vscode.window.showQuickPick(filePicks, {
    canPickMany: true,
    title: `Select transcript files to export (${allFiles.length} found)`,
    placeHolder: "Deselect files you do not want to export",
  });

  if (!selectedFileItems || selectedFileItems.length === 0) {
    logger.appendLine(`[${new Date().toISOString()}] Transcript export cancelled: no files selected`);
    return;
  }

  const selectedFiles = allFiles.filter((f) =>
    selectedFileItems.some(
      (item) => item.label === f.relativePath && item.description === f.projectKey
    )
  );

  const confirm = await vscode.window.showWarningMessage(
    `This will create a private Gist with ${selectedFiles.length} transcript file(s). ` +
      "It is not listed on your public profile, but anyone with the direct URL can still open it. " +
      "Transcripts may contain sensitive data (prompts, code, secrets). Continue?",
    { modal: true },
    "Export"
  );
  if (confirm !== "Export") return;

  const { gistFiles } = await buildExportBundleV2(selectedFiles, selectedProjects);

  const client = new GistClient(token);

  vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Creating private Gist with transcripts...",
      cancellable: false,
    },
    async () => {
      const result = await withRetry(() =>
        client.createGist(gistFiles, "Cursor Sync - Agent Transcripts Export")
      );

      if (!result.ok) {
        vscode.window.showErrorMessage(`Transcript export failed: ${result.error.message}`);
        logger.appendLine(
          `[${new Date().toISOString()}] Transcript export failed: ${result.error.category} - ${result.error.message}`
        );
        return;
      }

      const gistUrl = result.data.html_url;
      logger.appendLine(`[${new Date().toISOString()}] Transcript export succeeded: ${gistUrl}`);

      const action = await vscode.window.showInformationMessage(
        `Transcript export successful! Private Gist: ${gistUrl}. Anyone with the link can open it.`,
        "Copy URL"
      );
      if (action === "Copy URL") {
        await vscode.env.clipboard.writeText(gistUrl);
      }
    }
  );
}

export async function executeImportTranscripts(
  context: vscode.ExtensionContext
): Promise<void> {
  const logger = getLogger();
  logger.appendLine(`[${new Date().toISOString()}] Transcript import started`);

  const input = await vscode.window.showInputBox({
    prompt: "Enter the Gist URL or ID containing exported transcripts",
    placeHolder: "e.g., https://gist.github.com/username/abc123 or abc123",
  });

  if (!input) {
    logger.appendLine(`[${new Date().toISOString()}] Transcript import cancelled: no input`);
    return;
  }

  const gistId = extractGistId(input);
  if (!gistId) {
    vscode.window.showErrorMessage("Invalid Gist URL or ID.");
    return;
  }

  const token = await getToken(context);
  const client = new GistClient(token);

  const gistResult = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Fetching transcript Gist...",
      cancellable: false,
    },
    async () => withRetry(() => client.getGist(gistId))
  );

  if (!gistResult.ok) {
    vscode.window.showErrorMessage(`Import failed: ${gistResult.error.message}`);
    return;
  }

  const gistData: GistResponse = gistResult.data;
  const manifestFile = gistData.files[TRANSCRIPT_MANIFEST_FILE_NAME];
  if (!manifestFile) {
    vscode.window.showErrorMessage(
      "Import failed: transcript-manifest.json not found. This Gist may not contain exported transcripts."
    );
    return;
  }

  let manifest: TranscriptManifestV1 | TranscriptManifestV2;
  try {
    manifest = parseTranscriptBundleManifest(manifestFile.content);
  } catch (error) {
    vscode.window.showErrorMessage(
      `Import failed: ${error instanceof Error ? error.message : "invalid transcript-manifest.json."}`
    );
    return;
  }

  const localProjects = await discoverProjects();
  if (localProjects.length === 0) {
    vscode.window.showErrorMessage(
      "No local Cursor projects found under ~/.cursor/projects/. " +
        "Open a project in Cursor first to create a project directory."
    );
    return;
  }

  const projectMapping = await promptForProjectMapping(
    Object.keys(manifest.sourceProjects),
    Object.fromEntries(
      Object.entries(manifest.sourceProjects).map(([projectKey, info]) => [
        projectKey,
        { fileCount: info.fileCount },
      ])
    ),
    localProjects,
    logger
  );

  if (projectMapping === null) {
    return;
  }

  if (projectMapping.size === 0) {
    vscode.window.showInformationMessage("No projects mapped. Import cancelled.");
    return;
  }

  if (isTranscriptManifestV2(manifest)) {
    await importTranscriptBundleV2(context, gistData, manifest, projectMapping, logger);
    return;
  }

  await importTranscriptBundleV1(context, gistData, manifest, projectMapping, logger);
}

function extractGistId(input: string): string | null {
  const match = input.match(
    /(?:gist\.github\.com\/[^/]+\/|)([a-f0-9]{32}|[a-f0-9]{20})/i
  );
  return match ? match[1] : null;
}

async function buildExportBundleV2(
  selectedFiles: TranscriptFileEntry[],
  selectedProjects: ProjectInfo[]
): Promise<{ gistFiles: Record<string, { content: string }>; manifest: TranscriptManifestV2 }> {
  const createdAt = new Date().toISOString();
  const artifactContents = new Map<string, { content: string }>();
  const artifactEntries = new Map<string, TranscriptBundleArtifactEntry>();
  const conversationStates = new Map<string, ExportConversationState>();
  const projectAccumulators = new Map<string, ExportProjectAccumulator>();
  const globalWarnings = new Set<string>();
  const sortedFiles = [...selectedFiles].sort((a, b) => {
    const projectCompare = a.projectKey.localeCompare(b.projectKey);
    return projectCompare !== 0 ? projectCompare : a.relativePath.localeCompare(b.relativePath);
  });

  for (const project of selectedProjects) {
    projectAccumulators.set(project.folderName, {
      folderName: project.folderName,
      fileCount: 0,
      conversationIds: new Set<string>(),
      artifactCount: 0,
    });
  }

  for (const file of sortedFiles) {
    const fileBuffer = await fs.readFile(file.absolutePath);
    const fileContent = fileBuffer.toString("utf-8");
    const conversationId = getConversationIdFromRelativePath(file.relativePath);
    const conversationKey = `${file.projectKey}:${conversationId}`;
    const projectAccumulator = projectAccumulators.get(file.projectKey) ?? {
      folderName: file.projectKey,
      fileCount: 0,
      conversationIds: new Set<string>(),
      artifactCount: 0,
    };

    projectAccumulator.fileCount += 1;
    projectAccumulator.conversationIds.add(conversationId);
    projectAccumulators.set(file.projectKey, projectAccumulator);

    const stat = await fs.stat(file.absolutePath);
    const fileUpdatedAt = stat.mtime.toISOString();
    const conversationState = conversationStates.get(conversationKey) ?? {
      projectKey: file.projectKey,
      conversationId,
      transcriptArtifacts: [],
      transcriptRelativePaths: [],
      primaryTranscriptContent: fileContent,
      primaryTranscriptSelectedAt: "",
      lastUpdatedAt: fileUpdatedAt,
      warnings: [],
    };

    if (
      conversationState.primaryTranscriptSelectedAt.length === 0 ||
      path.basename(file.relativePath) === `${conversationId}.jsonl`
    ) {
      conversationState.primaryTranscriptContent = fileContent;
      conversationState.primaryTranscriptSelectedAt = file.relativePath;
    }

    if (fileUpdatedAt > conversationState.lastUpdatedAt) {
      conversationState.lastUpdatedAt = fileUpdatedAt;
    }

    conversationState.transcriptRelativePaths.push(file.relativePath);

    const scopedRelativePath =
      getConversationScopedRelativePath(file.relativePath) || path.basename(file.relativePath);
    const artifactKey = bundleArtifactSyncKey(
      file.projectKey,
      conversationId,
      "transcript",
      scopedRelativePath
    );

    artifactContents.set(artifactKey, {
      content: fileContent,
    });
    artifactEntries.set(artifactKey, {
      projectKey: file.projectKey,
      conversationId,
      kind: "transcript",
      checksum: computeArtifactChecksum(fileBuffer),
      sizeBytes: fileBuffer.length,
      contentType: "application/x-jsonlines",
      sourceRelativePath: file.relativePath,
    });
    conversationState.transcriptArtifacts.push(artifactKey);
    conversationStates.set(conversationKey, conversationState);
  }

  const conversationRecords = new Map<string, TranscriptBundleConversationEntry>();
  const sortedConversationKeys = [...conversationStates.keys()].sort();

  for (const conversationKey of sortedConversationKeys) {
    const conversationState = conversationStates.get(conversationKey);
    if (!conversationState) {
      continue;
    }

    const projectAccumulator = projectAccumulators.get(conversationState.projectKey);
    const storeSnapshot = await findStoreDbForConversation(conversationState.conversationId);
    if (storeSnapshot) {
      const storeBuffer = await fs.readFile(storeSnapshot.absolutePath);
      const encoded = encodeTranscriptArtifact(storeBuffer, true);
      const storeArtifactKey = bundleArtifactSyncKey(
        conversationState.projectKey,
        conversationState.conversationId,
        "store",
        "store.db"
      );

      artifactContents.set(storeArtifactKey, { content: encoded.content });
      artifactEntries.set(storeArtifactKey, {
        projectKey: conversationState.projectKey,
        conversationId: conversationState.conversationId,
        kind: "store",
        checksum: computeArtifactChecksum(storeBuffer),
        sizeBytes: storeBuffer.length,
        contentType: "application/octet-stream",
        encoding: encoded.encoding,
        sourceWorkspaceKey: storeSnapshot.workspaceKey,
      });
      conversationState.storeArtifact = storeArtifactKey;
      conversationState.sourceWorkspaceKey = storeSnapshot.workspaceKey;
      if (projectAccumulator) {
        projectAccumulator.artifactCount += 1;
      }
    } else {
      conversationState.warnings.push(
        "Store snapshot was not found under ~/.cursor/chats; transcript JSONL will still be exported."
      );
    }

    const sidebarSnapshot = await buildSidebarMetadataSnapshot(conversationState, createdAt);
    const sidebarBuffer = Buffer.from(JSON.stringify(sidebarSnapshot, null, 2), "utf-8");
    const sidebarArtifactKey = bundleArtifactSyncKey(
      conversationState.projectKey,
      conversationState.conversationId,
      "sidebar",
      "sidebar-metadata.json"
    );

    artifactContents.set(sidebarArtifactKey, {
      content: sidebarBuffer.toString("utf-8"),
    });
    artifactEntries.set(sidebarArtifactKey, {
      projectKey: conversationState.projectKey,
      conversationId: conversationState.conversationId,
      kind: "sidebar",
      checksum: computeArtifactChecksum(sidebarBuffer),
      sizeBytes: sidebarBuffer.length,
      contentType: "application/json",
    });

    const summary = summarizeTranscriptForSidebar(
      conversationState.primaryTranscriptContent,
      conversationState.conversationId
    );
    const lastUpdatedAt =
      summary.lastUpdatedAt ?? conversationState.lastUpdatedAt ?? createdAt;

    conversationRecords.set(conversationKey, {
      projectKey: conversationState.projectKey,
      conversationId: conversationState.conversationId,
      title: summary.title,
      subtitle: summary.subtitle,
      previewText: summary.previewText,
      lastUpdatedAt,
      transcriptArtifacts: [...conversationState.transcriptArtifacts].sort(),
      storeArtifact: conversationState.storeArtifact,
      ...(conversationState.sourceWorkspaceKey
        ? { storeSourceWorkspaceKey: conversationState.sourceWorkspaceKey }
        : {}),
      sidebarArtifact: sidebarArtifactKey,
      warnings: [...conversationState.warnings].sort(),
    });

    if (projectAccumulator) {
      projectAccumulator.artifactCount += conversationState.transcriptArtifacts.length + 1;
    }

    for (const warning of conversationState.warnings) {
      globalWarnings.add(
        `${conversationState.projectKey}/${conversationState.conversationId}: ${warning}`
      );
    }
  }

  const sourceProjects = toSortedRecord(
    [...projectAccumulators.entries()].map(([projectKey, accumulator]) => [
      projectKey,
      {
        folderName: accumulator.folderName,
        fileCount: accumulator.fileCount,
        conversationCount: accumulator.conversationIds.size,
        artifactCount: accumulator.artifactCount,
      } satisfies TranscriptBundleSourceProjectInfo,
    ])
  );

  const artifacts = toSortedRecord([...artifactEntries.entries()]);
  const conversations = toSortedRecord([...conversationRecords.entries()]);
  const manifest: TranscriptManifestV2 = {
    schemaVersion: 2,
    type: "agent-transcripts",
    createdAt,
    sourceMachineId: computeTranscriptMachineId(),
    sourceOS: process.platform,
    sourceProjects,
    artifacts,
    conversations,
    warnings: [...globalWarnings].sort(),
  };

  const gistFiles: Record<string, { content: string }> = {};
  for (const [artifactKey, file] of [...artifactContents.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    gistFiles[syncKeyToGistFileName(artifactKey)] = file;
  }

  gistFiles[TRANSCRIPT_MANIFEST_FILE_NAME] = {
    content: JSON.stringify(manifest, null, 2),
  };

  return { gistFiles, manifest };
}

async function importTranscriptBundleV1(
  context: vscode.ExtensionContext,
  gistData: GistResponse,
  manifest: TranscriptManifestV1,
  projectMapping: Map<string, ProjectInfo>,
  logger: ReturnType<typeof getLogger>
): Promise<void> {
  const operations: RestoreOperation[] = [];

  for (const [gistFileName, gistFile] of Object.entries(gistData.files)) {
    if (gistFileName === TRANSCRIPT_MANIFEST_FILE_NAME) {
      continue;
    }

    const syncKey = gistFileNameToSyncKey(gistFileName);
    const manifestEntry = manifest.files[syncKey];
    if (!manifestEntry) {
      continue;
    }

    const targetProject = projectMapping.get(manifestEntry.projectKey);
    if (!targetProject) {
      continue;
    }

    const relativeInProject = syncKey.slice(`transcripts/${manifestEntry.projectKey}/`.length);
    const content = Buffer.from(gistFile.content, "utf-8");
    const checksum = computeArtifactChecksum(content);
    if (checksum !== manifestEntry.checksum) {
      vscode.window.showErrorMessage(
        `Import failed: checksum mismatch for ${relativeInProject}.`
      );
      return;
    }

    operations.push({
      absolutePath: path.join(
        targetProject.fullPath,
        "agent-transcripts",
        ...relativeInProject.split("/")
      ),
      content,
      checksum,
      syncKey,
      kind: "transcript",
      conversationId: getConversationIdFromRelativePath(relativeInProject),
    });
  }

  if (operations.length === 0) {
    vscode.window.showInformationMessage("No transcript files to write after mapping.");
    return;
  }

  const fileItems: vscode.QuickPickItem[] = operations.map((operation) => ({
    label: path.basename(operation.absolutePath),
    description: operation.absolutePath,
    picked: true,
  }));

  const selectedItems = await vscode.window.showQuickPick(fileItems, {
    canPickMany: true,
    title: `Select transcript files to import (${operations.length} total)`,
    placeHolder: "Deselect files you do not want to import",
  });

  if (!selectedItems || selectedItems.length === 0) {
    logger.appendLine(`[${new Date().toISOString()}] Transcript import cancelled: no files selected`);
    return;
  }

  const selectedPaths = new Set(selectedItems.map((item) => item.description));
  const selectedOperations = operations.filter((operation) =>
    selectedPaths.has(operation.absolutePath)
  );

  const augmented = await augmentV1ImportOperations(
    gistData,
    selectedOperations,
    projectMapping,
    logger
  );

  await previewAndApplyImportPlan(context, augmented, "Import transcript files", logger, {
    importRestoreReport: true,
  });
}

async function importTranscriptBundleV2(
  context: vscode.ExtensionContext,
  gistData: GistResponse,
  manifest: TranscriptManifestV2,
  projectMapping: Map<string, ProjectInfo>,
  logger: ReturnType<typeof getLogger>
): Promise<void> {
  const availableConversations = Object.entries(manifest.conversations)
    .filter(([, conversation]) => projectMapping.has(conversation.projectKey))
    .sort(([a], [b]) => a.localeCompare(b));

  if (availableConversations.length === 0) {
    vscode.window.showInformationMessage("No conversations remain after project mapping.");
    return;
  }

  const conversationItems: Array<vscode.QuickPickItem & { conversationKey: string }> =
    availableConversations.map(([conversationKey, conversation]) => ({
      conversationKey,
      label: conversation.title,
      description: `${humanLabel(conversation.projectKey)} · ${conversation.conversationId}`,
      detail: [
        conversation.subtitle,
        conversation.storeArtifact ? "store snapshot included" : "store snapshot missing",
        "sidebar sidecar + state.vscdb merge when snapshot allows",
      ].join(" · "),
      picked: true,
    }));

  const selectedConversations = await vscode.window.showQuickPick(conversationItems, {
    canPickMany: true,
    title: `Select conversations to import (${conversationItems.length} available)`,
    placeHolder: "Deselect conversations you do not want to restore",
  });

  if (!selectedConversations || selectedConversations.length === 0) {
    logger.appendLine(
      `[${new Date().toISOString()}] Transcript import cancelled: no conversations selected`
    );
    return;
  }

  const selectedConversationKeys = new Set(
    selectedConversations.map((conversation) => conversation.conversationKey)
  );

  const chatsWorkspaceKeys = await listChatsWorkspaceKeys();
  const { resolved: derivedWorkspace, ambiguousSources } = deriveStoreWorkspaceMapping(
    manifest,
    selectedConversationKeys,
    projectMapping
  );
  let workspaceMapping = new Map<string, string>(derivedWorkspace);
  const requiredStoreWorkspaceKeys = collectRequiredStoreWorkspaceKeys(
    manifest,
    selectedConversationKeys
  );
  const promptWorkspaceSources = new Set<string>(ambiguousSources);
  for (const swk of requiredStoreWorkspaceKeys) {
    if (chatsWorkspaceKeys.length > 0 && !chatsWorkspaceKeys.includes(swk)) {
      promptWorkspaceSources.add(swk);
    }
  }
  if (promptWorkspaceSources.size > 0) {
    for (const swk of promptWorkspaceSources) {
      workspaceMapping.delete(swk);
    }
    const prompted = await promptForWorkspaceMapping(
      [...promptWorkspaceSources].sort(),
      chatsWorkspaceKeys,
      logger
    );
    if (prompted === null) {
      return;
    }
    for (const [k, v] of prompted) {
      workspaceMapping.set(k, v);
    }
  }

  const preflightErrors: string[] = [];
  for (const [conversationKey, conversation] of availableConversations) {
    if (!selectedConversationKeys.has(conversationKey)) continue;
    const targetProject = projectMapping.get(conversation.projectKey);
    if (!targetProject) continue;
    preflightErrors.push(
      ...(await preflightV2ConversationImport({
        gistData,
        manifest,
        conversation,
        targetProject,
        workspaceMapping,
      }))
    );
  }

  if (preflightErrors.length > 0) {
    vscode.window.showErrorMessage(preflightErrors[0]!);
    return;
  }

  const operations: RestoreOperation[] = [];
  const stagedWarnings = new Set<string>();

  for (const [conversationKey, conversation] of availableConversations) {
    if (!selectedConversationKeys.has(conversationKey)) {
      continue;
    }

    const targetProject = projectMapping.get(conversation.projectKey);
    if (!targetProject) {
      continue;
    }

    const artifactIds = [
      ...conversation.transcriptArtifacts,
      conversation.sidebarArtifact,
      ...(conversation.storeArtifact ? [conversation.storeArtifact] : []),
    ];

    for (const artifactId of artifactIds) {
      const artifactEntry = manifest.artifacts[artifactId];
      if (!artifactEntry) {
        continue;
      }

      const gistFile = gistData.files[syncKeyToGistFileName(artifactId)];
      if (!gistFile) {
        continue;
      }

      const content = decodeTranscriptArtifact(gistFile.content, artifactEntry.encoding);

      operations.push({
        absolutePath: resolveArtifactImportPath(targetProject, artifactEntry, workspaceMapping),
        content,
        checksum: artifactEntry.checksum,
        syncKey: artifactId,
        kind: artifactEntry.kind,
        conversationId: artifactEntry.conversationId,
      });
    }

    for (const warning of conversation.warnings) {
      stagedWarnings.add(`${conversation.conversationId}: ${warning}`);
    }
  }

  if (operations.length === 0) {
    vscode.window.showInformationMessage("No bundle artifacts to restore after selection.");
    return;
  }

  await previewAndApplyImportPlan(context, operations, "Import conversation bundle", logger, {
    importRestoreReport: true,
    warnings: [...stagedWarnings].sort(),
  });
}

async function promptForProjectMapping(
  sourceProjectKeys: string[],
  sourceProjects: Record<string, { fileCount: number }>,
  localProjects: ProjectInfo[],
  logger: ReturnType<typeof getLogger>
): Promise<Map<string, ProjectInfo> | null> {
  if (sourceProjectKeys.length === 0) {
    vscode.window.showInformationMessage("No source projects found in the transcript export.");
    return new Map();
  }

  const projectMapping: Map<string, ProjectInfo> = new Map();

  for (const sourceProjectKey of sourceProjectKeys.sort()) {
    const sourceInfo = sourceProjects[sourceProjectKey];
    const sourceLabel = humanLabel(sourceProjectKey);
    const picks: vscode.QuickPickItem[] = localProjects.map((project) => ({
      label: project.label,
      description: project.folderName,
      detail: project.fullPath,
    }));

    picks.unshift({ label: "(Skip this project)", description: "skip" });

    const selected = await vscode.window.showQuickPick(picks, {
      title: `Map source project "${sourceLabel}" (${sourceInfo.fileCount} file(s)) to a local project`,
      placeHolder: `Select the local project to receive transcripts from "${sourceLabel}"`,
    });

    if (!selected) {
      logger.appendLine(`[${new Date().toISOString()}] Transcript import cancelled during project mapping`);
      return null;
    }

    if (selected.description === "skip") {
      continue;
    }

    const targetProject = localProjects.find(
      (project) => project.folderName === selected.description
    );
    if (targetProject) {
      projectMapping.set(sourceProjectKey, targetProject);
    }
  }

  return projectMapping;
}

async function previewAndApplyImportPlan(
  context: vscode.ExtensionContext,
  operations: RestoreOperation[],
  actionLabel: string,
  logger: ReturnType<typeof getLogger>,
  options: {
    importRestoreReport: boolean;
    warnings?: string[];
  }
): Promise<void> {
  const preview = await previewRestoreOperations(operations);

  if (preview.newFiles.length === 0 && preview.conflicts.length === 0) {
    const sidebarOps = preview.unchanged.filter((op) => op.kind === "sidebar");
    if (options.importRestoreReport && sidebarOps.length > 0) {
      try {
        const stateOutcome = await applySidebarStateRestoration(context, sidebarOps, logger);
        const report = mergeStateOutcomeIntoReport(
          {
            transcriptWritten: 0,
            storeWritten: 0,
            sidebarWritten: 0,
            stateDbMerged: 0,
            stateDbSkippedNoPayload: 0,
            stateDbSkippedNoDb: 0,
            statePartial: false,
            warnings: [],
          },
          stateOutcome
        );
        const warningParts = [
          ...(options.warnings ?? []),
          ...(report.warnings ?? []),
        ];
        const warningSuffix =
          warningParts.length > 0 ? ` Warnings: ${warningParts.slice(0, 5).join(" ")}` : "";
        const detailSuffix = ` State.vscdb merges ${report.stateDbMerged}. Skipped state merge (no composer payload) ${report.stateDbSkippedNoPayload}, (no DB) ${report.stateDbSkippedNoDb}.${report.statePartial ? " Partial state restoration." : ""}`;
        vscode.window.showInformationMessage(
          `Transcript import: artifacts already on disk; re-applied sidebar state.${detailSuffix}${warningSuffix}`
        );
        if (report.stateDbMerged > 0) {
          const reloadAction = "Reload Window";
          const selected = await vscode.window.showInformationMessage(
            "Sidebar state was updated on disk. Reload Cursor to pick up imported conversation visibility.",
            reloadAction
          );
          if (selected === reloadAction) {
            await vscode.commands.executeCommand("workbench.action.reloadWindow");
          }
        }
        logger.appendLine(
          `[${new Date().toISOString()}] Transcript import (unchanged files): stateMerged=${report.stateDbMerged} skippedPayload=${report.stateDbSkippedNoPayload} skippedDb=${report.stateDbSkippedNoDb}`
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(
          `Transcript import: sidebar state merge failed: ${msg}`
        );
        logger.appendLine(
          `[${new Date().toISOString()}] Transcript import (unchanged files) state merge error: ${msg}`
        );
      }
      return;
    }
    vscode.window.showInformationMessage(
      `${actionLabel} skipped: all selected artifacts are already up to date.`
    );
    return;
  }

  const summary = [
    `${operations.length} artifact(s) selected`,
    `${preview.newFiles.length} new`,
    `${preview.conflicts.length} conflict${preview.conflicts.length === 1 ? "" : "s"}`,
    `${preview.unchanged.length} unchanged`,
  ].join(", ");

  let conflictPolicy: "overwrite" | "skip" = "overwrite";
  if (preview.conflicts.length > 0) {
    const choice = await vscode.window.showWarningMessage(
      `${actionLabel}: ${summary}. Choose how to handle conflicts.`,
      { modal: true },
      "Overwrite Conflicts",
      "Skip Conflicts",
      "Cancel"
    );

    if (choice === "Cancel" || !choice) {
      logger.appendLine(`[${new Date().toISOString()}] Transcript import cancelled during conflict review`);
      return;
    }

    conflictPolicy = choice === "Skip Conflicts" ? "skip" : "overwrite";
  } else {
    const choice = await vscode.window.showInformationMessage(
      `${actionLabel}: ${summary}. Use the Import action to write files and update sidebar state.`,
      { modal: true },
      "Import",
      "Cancel"
    );

    if (choice !== "Import") {
      logger.appendLine(`[${new Date().toISOString()}] Transcript import cancelled during preview confirmation`);
      return;
    }
  }

  const toWrite = [
    ...preview.newFiles,
    ...(conflictPolicy === "overwrite" ? preview.conflicts : []),
  ].sort((a, b) => a.absolutePath.localeCompare(b.absolutePath));

  if (toWrite.length === 0) {
    vscode.window.showInformationMessage(
      `${actionLabel} skipped: conflicts were left untouched and the rest was already up to date.`
    );
    return;
  }

  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Writing ${toWrite.length} transcript artifact(s)...`,
      cancellable: false,
    },
    async () => applyRestoreOperations(context, toWrite, logger)
  );

  if (!result.ok) {
    vscode.window.showErrorMessage(result.message);
    return;
  }

  let report: ImportRestoreReport | undefined;
  if (options.importRestoreReport) {
    const sidebarOps = toWrite.filter((op) => op.kind === "sidebar");
    report = buildImportRestoreReportFromOperations(toWrite);
    if (sidebarOps.length > 0) {
      const stateOutcome = await applySidebarStateRestoration(context, sidebarOps, logger);
      report = mergeStateOutcomeIntoReport(report, stateOutcome);
    }
  }

  const warningParts = [
    ...(options.warnings ?? []),
    ...(report?.warnings ?? []),
  ];
  const warningSuffix =
    warningParts.length > 0 ? ` Warnings: ${warningParts.slice(0, 5).join(" ")}` : "";

  const detailSuffix = report
    ? ` Restored: transcript files ${report.transcriptWritten}, store.db ${report.storeWritten}, sidebar JSON ${report.sidebarWritten}, state.vscdb merges ${report.stateDbMerged}. Skipped state merge (no composer payload) ${report.stateDbSkippedNoPayload}, (no DB) ${report.stateDbSkippedNoDb}.${report.statePartial ? " Partial state/sidebar restoration." : ""}`
    : "";

  vscode.window.showInformationMessage(
    `Transcript import complete: ${result.writtenCount} artifact(s) written, ${preview.unchanged.length} unchanged, ` +
      `${conflictPolicy === "skip" ? preview.conflicts.length : 0} conflict(s) skipped.${detailSuffix}${warningSuffix}`
  );
  if ((report?.stateDbMerged ?? 0) > 0) {
    const reloadAction = "Reload Window";
    const selected = await vscode.window.showInformationMessage(
      "Sidebar state was updated on disk. Reload Cursor to pick up imported conversation visibility.",
      reloadAction
    );
    if (selected === reloadAction) {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
  }
  logger.appendLine(
    `[${new Date().toISOString()}] Transcript import succeeded: ${result.writtenCount} artifacts` +
      (report
        ? `; transcript=${report.transcriptWritten} store=${report.storeWritten} sidebar=${report.sidebarWritten} stateMerged=${report.stateDbMerged}`
        : "")
  );
}

async function previewRestoreOperations(
  operations: RestoreOperation[]
): Promise<RestorePreview> {
  const preview: RestorePreview = {
    newFiles: [],
    conflicts: [],
    unchanged: [],
  };

  for (const operation of operations) {
    try {
      const existing = await fs.readFile(operation.absolutePath);
      const existingChecksum = computeArtifactChecksum(existing);
      if (existingChecksum === operation.checksum) {
        preview.unchanged.push(operation);
      } else {
        preview.conflicts.push(operation);
      }
    } catch {
      preview.newFiles.push(operation);
    }
  }

  return preview;
}

async function applyRestoreOperations(
  context: vscode.ExtensionContext,
  operations: RestoreOperation[],
  logger: ReturnType<typeof getLogger>
): Promise<
  | { ok: true; writtenCount: number }
  | { ok: false; message: string }
> {
  const existingPaths: string[] = [];
  const createdPaths: string[] = [];

  for (const operation of operations) {
    const outcome = await accessPathOutcome(operation.absolutePath);
    if (outcome === "timeout") {
      logger.appendLine(
        `[${new Date().toISOString()}] Transcript import: access timed out for ${operation.absolutePath}`
      );
      return {
        ok: false,
        message:
          "Transcript import failed: a destination path did not respond in time (slow disk, network folder, or permission issue).",
      };
    }
    if (outcome === "exists") {
      existingPaths.push(operation.absolutePath);
    } else {
      createdPaths.push(operation.absolutePath);
    }
  }

  const { entries: backupEntries } = await createBackup(context, existingPaths);

  let writtenCount = 0;

  for (let i = 0; i < operations.length; i += 1) {
    const operation = operations[i]!;
    try {
      await fs.mkdir(path.dirname(operation.absolutePath), { recursive: true });
      const tmpPath = `${operation.absolutePath}.tmp`;
      await fs.writeFile(tmpPath, operation.content);
      await fs.rename(tmpPath, operation.absolutePath);
      writtenCount += 1;
    } catch (error) {
      logger.appendLine(
        `[${new Date().toISOString()}] Transcript write failed for ${operation.absolutePath}: ${error instanceof Error ? error.message : String(error)}`
      );
      await rollbackFromBackup(backupEntries);
      await Promise.all(
        createdPaths.map((createdPath) => fs.rm(createdPath, { force: true }).catch(() => undefined))
      );
      return {
        ok: false,
        message: "Transcript import failed: file write error. Existing files were rolled back.",
      };
    }
  }

  await pruneOldBackups(context);

  return { ok: true, writtenCount };
}

async function buildSidebarMetadataSnapshot(
  conversationState: ExportConversationState,
  exportedAt: string
): Promise<Record<string, unknown>> {
  const summary = summarizeTranscriptForSidebar(
    conversationState.primaryTranscriptContent,
    conversationState.conversationId
  );
  const evidence = await extractSidebarStateEvidence(conversationState.conversationId);

  const composerIds = collectComposerIdsForConversation(conversationState);
  let composerHeadersRestore: unknown;
  let composerDataRestore: unknown;
  if (evidence?.stateDbPath) {
    try {
      const headerRows = await querySqliteRows(
        evidence.stateDbPath,
        "SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders' LIMIT 1;"
      );
      const headerRaw = headerRows[0]?.value;
      if (headerRaw != null) {
        composerHeadersRestore = coerceSqliteValue(headerRaw);
      }
      const dataRows = await querySqliteRows(
        evidence.stateDbPath,
        "SELECT value FROM ItemTable WHERE key = 'composer.composerData' LIMIT 1;"
      );
      const dataRaw = dataRows[0]?.value;
      if (dataRaw != null) {
        const parsedComposerData = coerceSqliteValue(dataRaw);
        composerDataRestore = filterComposerDataPayload(parsedComposerData, composerIds);
      }
    } catch (error) {
      if (!isExecFileTimeoutError(error)) {
        throw error;
      }
    }
  }
  const fallbackComposerHeaders = buildFallbackComposerHeadersPayload(
    conversationState.conversationId,
    summary,
    exportedAt
  );
  const composerHeadersPayload =
    composerHeadersRestore && typeof composerHeadersRestore === "object"
      ? (composerHeadersRestore as Record<string, unknown>)
      : fallbackComposerHeaders;

  return {
    schemaVersion: 1,
    snapshotType: "cursor-sidebar-metadata",
    exportedAt,
    projectKey: conversationState.projectKey,
    conversationId: conversationState.conversationId,
    title: summary.title,
    subtitle: summary.subtitle,
    previewText: summary.previewText,
    messageCount: summary.messageCount,
    participants: summary.participants,
    lastUpdatedAt: summary.lastUpdatedAt ?? conversationState.lastUpdatedAt ?? exportedAt,
    transcriptRelativePaths: [...conversationState.transcriptRelativePaths].sort(),
    storeSnapshotIncluded: Boolean(conversationState.storeArtifact),
    sourceWorkspaceKey: conversationState.sourceWorkspaceKey ?? null,
    extraction: evidence?.extraction ?? "derived-only",
    stateDbPath: evidence?.stateDbPath ?? null,
    matchedItemTableRows: evidence?.matchedItemTableRows ?? [],
    matchedCursorDiskRows: evidence?.matchedCursorDiskRows ?? [],
    composerSummaryRows: evidence?.composerSummaryRows ?? [],
    composerHeaders: composerHeadersPayload,
    composerHeadersRestore: composerHeadersRestore ?? null,
    composerData: composerDataRestore ?? null,
    composerDataRestore: composerDataRestore ?? null,
    warnings: [...conversationState.warnings].sort(),
  };
}

function getSourceProjectKeyFromTranscriptSyncKey(syncKey: string): string | undefined {
  const prefix = "transcripts/";
  if (!syncKey.startsWith(prefix)) {
    return undefined;
  }
  const rest = syncKey.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) {
    return slash === -1 && rest.length > 0 ? rest : undefined;
  }
  return rest.slice(0, slash);
}

function decodeTolerantStoreGistContent(raw: string): Buffer {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return Buffer.alloc(0);
  }
  const noWs = trimmed.replace(/\s/g, "");
  try {
    const asB64 = Buffer.from(noWs, "base64");
    if (asB64.length >= 16 && asB64.subarray(0, 15).toString("latin1") === "SQLite format 3") {
      return asB64;
    }
    if (noWs.length > 0 && /^[A-Za-z0-9+/]+=*$/.test(noWs) && noWs.length % 4 === 0) {
      return asB64;
    }
  } catch {
  }
  return decodeTranscriptArtifact(trimmed, undefined);
}

async function augmentV1ImportOperations(
  gistData: GistResponse,
  transcriptOperations: RestoreOperation[],
  projectMapping: ReadonlyMap<string, ProjectInfo>,
  logger: ReturnType<typeof getLogger>
): Promise<RestoreOperation[]> {
  const extra: RestoreOperation[] = [];
  const seenStores = new Set<string>();
  const seenSidebars = new Set<string>();

  const groups = new Map<
    string,
    {
      sourceProjectKey: string;
      conversationId: string;
      targetProject: ProjectInfo;
      ops: RestoreOperation[];
    }
  >();

  for (const op of transcriptOperations) {
    const sourcePk = getSourceProjectKeyFromTranscriptSyncKey(op.syncKey);
    if (!sourcePk || !op.conversationId) {
      continue;
    }
    const targetProject = projectMapping.get(sourcePk);
    if (!targetProject) {
      continue;
    }
    const gkey = `${sourcePk}:${op.conversationId}`;
    let g = groups.get(gkey);
    if (!g) {
      g = { sourceProjectKey: sourcePk, conversationId: op.conversationId, targetProject, ops: [] };
      groups.set(gkey, g);
    }
    g.ops.push(op);
  }

  const createdAt = new Date().toISOString();
  const sortedGroups = [...groups.values()].sort((a, b) =>
    a.sourceProjectKey !== b.sourceProjectKey
      ? a.sourceProjectKey.localeCompare(b.sourceProjectKey)
      : a.conversationId.localeCompare(b.conversationId)
  );

  for (const g of sortedGroups) {
    const storeSyncKey = bundleArtifactSyncKey(
      g.sourceProjectKey,
      g.conversationId,
      "store",
      "store.db"
    );
    const sidebarSyncKey = bundleArtifactSyncKey(
      g.sourceProjectKey,
      g.conversationId,
      "sidebar",
      "sidebar-metadata.json"
    );

    const storeGist = gistData.files[syncKeyToGistFileName(storeSyncKey)];
    if (storeGist && !seenStores.has(storeSyncKey)) {
      seenStores.add(storeSyncKey);
      const storeBuf = decodeTolerantStoreGistContent(storeGist.content);
      if (storeBuf.length > 0) {
        extra.push({
          absolutePath: path.join(
            resolveChatsRoot(),
            g.targetProject.folderName,
            g.conversationId,
            "store.db"
          ),
          content: storeBuf,
          checksum: computeArtifactChecksum(storeBuf),
          syncKey: storeSyncKey,
          kind: "store",
          conversationId: g.conversationId,
        });
      } else {
        logger.appendLine(
          `[${new Date().toISOString()}] V1 import skipped empty store artifact for ${storeSyncKey}`
        );
      }
    }

    if (seenSidebars.has(sidebarSyncKey)) {
      continue;
    }
    seenSidebars.add(sidebarSyncKey);

    const sidebarGist = gistData.files[syncKeyToGistFileName(sidebarSyncKey)];
    let sidebarBuffer: Buffer;
    if (sidebarGist) {
      sidebarBuffer = Buffer.from(sidebarGist.content, "utf-8");
    } else {
      const transcriptRelativePaths = [
        ...new Set(
          g.ops.map((op) => op.syncKey.slice(`transcripts/${g.sourceProjectKey}/`.length))
        ),
      ].sort();
      let primaryContent = g.ops[0]!.content.toString("utf-8");
      let primaryAt = transcriptRelativePaths[0] ?? "";
      for (const op of g.ops) {
        const rel = op.syncKey.slice(`transcripts/${g.sourceProjectKey}/`.length);
        if (path.basename(rel, path.extname(rel)) === g.conversationId) {
          primaryContent = op.content.toString("utf-8");
          primaryAt = rel;
          break;
        }
      }
      const synthetic: ExportConversationState = {
        projectKey: g.sourceProjectKey,
        conversationId: g.conversationId,
        transcriptArtifacts: [],
        transcriptRelativePaths,
        primaryTranscriptContent: primaryContent,
        primaryTranscriptSelectedAt: primaryAt,
        lastUpdatedAt: createdAt,
        warnings: [],
      };
      const snapshot = await buildSidebarMetadataSnapshot(synthetic, createdAt);
      sidebarBuffer = Buffer.from(JSON.stringify(snapshot, null, 2), "utf-8");
    }

    extra.push({
      absolutePath: path.join(
        g.targetProject.fullPath,
        "agent-transcripts",
        g.conversationId,
        "cursor-sidebar-metadata.json"
      ),
      content: sidebarBuffer,
      checksum: computeArtifactChecksum(sidebarBuffer),
      syncKey: sidebarSyncKey,
      kind: "sidebar",
      conversationId: g.conversationId,
    });
  }

  return [...transcriptOperations, ...extra].sort((a, b) => a.absolutePath.localeCompare(b.absolutePath));
}

function collectComposerIdsForConversation(conversationState: ExportConversationState): Set<string> {
  const ids = new Set<string>([conversationState.conversationId]);
  for (const relativePath of conversationState.transcriptRelativePaths) {
    const baseName = path.basename(relativePath, path.extname(relativePath));
    if (baseName) {
      ids.add(baseName);
    }
  }
  return ids;
}

function filterComposerDataPayload(value: unknown, composerIds: ReadonlySet<string>): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const source = value as Record<string, unknown>;
  const filtered: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (key === "allComposers" && Array.isArray(entry)) {
      filtered[key] = entry.filter((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          return false;
        }
        const id = getComposerId(item as Record<string, unknown>);
        return id.length > 0 && composerIds.has(id);
      });
      continue;
    }
    if (composerIds.has(key)) {
      filtered[key] = entry;
    } else if (!isLikelyComposerIdKey(key)) {
      filtered[key] = entry;
    }
  }
  return filtered;
}

function isLikelyComposerIdKey(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

function buildFallbackComposerHeadersPayload(
  conversationId: string,
  summary: ReturnType<typeof summarizeTranscriptForSidebar>,
  exportedAt: string
): ComposerHeadersPayload {
  const timestamp = summary.lastUpdatedAt ?? exportedAt;
  return {
    allComposers: [
      {
        composerId: conversationId,
        name: summary.title,
        subtitle: summary.subtitle,
        lastUpdatedAt: timestamp,
        lastOpenedAt: timestamp,
        createdAt: timestamp,
        hasUnreadMessages: false,
        isArchived: false,
        isDraft: false,
      },
    ],
  };
}

async function extractSidebarStateEvidence(
  conversationId: string
): Promise<SidebarStateEvidence | undefined> {
  const stateDbCandidates = await resolveStateDbCandidates();
  const escapedConversationId = conversationId.replace(/'/g, "''");

  for (const stateDbPath of stateDbCandidates) {
    let matchedItemTableRows: Array<Record<string, unknown>>;
    let matchedCursorDiskRows: Array<Record<string, unknown>>;
    let composerSummaryRows: Array<Record<string, unknown>>;
    try {
      matchedItemTableRows = await querySqliteRows(
        stateDbPath,
        `SELECT key, value FROM ItemTable WHERE value LIKE '%${escapedConversationId}%' LIMIT 10;`
      );
      matchedCursorDiskRows = await querySqliteRows(
        stateDbPath,
        `SELECT key, value FROM cursorDiskKV WHERE key LIKE '%${escapedConversationId}%' OR value LIKE '%${escapedConversationId}%' LIMIT 10;`
      );
      composerSummaryRows = await querySqliteRows(
        stateDbPath,
        "SELECT key, length(value) AS valueLength FROM ItemTable WHERE key IN ('composer.composerHeaders', 'composer.composerData') LIMIT 5;"
      );
    } catch (error) {
      if (isExecFileTimeoutError(error)) {
        continue;
      }
      throw error;
    }

    if (
      matchedItemTableRows.length > 0 ||
      matchedCursorDiskRows.length > 0 ||
      composerSummaryRows.length > 0
    ) {
      return {
        stateDbPath,
        extraction:
          matchedItemTableRows.length > 0 || matchedCursorDiskRows.length > 0
            ? "state-db-match"
            : "state-db-unmatched",
        matchedItemTableRows: matchedItemTableRows.map((row) => ({
          key: String(row.key ?? ""),
          value: coerceSqliteValue(row.value),
        })),
        matchedCursorDiskRows: matchedCursorDiskRows.map((row) => ({
          key: String(row.key ?? ""),
          value: coerceSqliteValue(row.value),
        })),
        composerSummaryRows: composerSummaryRows.map((row) => ({
          key: String(row.key ?? ""),
          valueLength: Number(row.valueLength ?? 0),
        })),
      };
    }
  }

  return undefined;
}

async function querySqliteRows(
  dbPath: string,
  sql: string
): Promise<Array<Record<string, unknown>>> {
  try {
    const { stdout } = await runSqliteQuery(dbPath, sql);
    const trimmed = stdout.trim();
    if (!trimmed) {
      return [];
    }

    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
      : [];
  } catch (error) {
    if (isExecFileTimeoutError(error)) {
      throw error;
    }
    return [];
  }
}

async function runSqliteQuery(
  dbPath: string,
  sql: string
): Promise<{ stdout: string; stderr: string }> {
  const execOpts = { maxBuffer: 64 * 1024 * 1024, timeout: SQLITE_SUBPROCESS_TIMEOUT_MS };
  try {
    return await execFile("sqlite3", ["-json", dbPath, sql], execOpts);
  } catch (error) {
    if (!isCommandMissingError(error, "sqlite3")) {
      throw error;
    }
    const pyScript = [
      "import json, sqlite3, sys",
      "db_path = sys.argv[1]",
      "sql = sys.argv[2]",
      "conn = sqlite3.connect(db_path)",
      "conn.row_factory = sqlite3.Row",
      "cur = conn.cursor()",
      "cur.execute(sql)",
      "def _coerce(v):",
      "    if isinstance(v, (bytes, bytearray, memoryview)):",
      "        return bytes(v).hex()",
      "    return v",
      "rows = [{k: _coerce(r[k]) for k in r.keys()} for r in cur.fetchall()]",
      "print(json.dumps(rows))",
      "conn.close()",
    ].join(";");
    return execFile("python3", ["-c", pyScript, dbPath, sql], execOpts);
  }
}

async function runSqliteScript(dbPath: string, script: string): Promise<void> {
  const execOpts = { input: script, maxBuffer: 64 * 1024 * 1024, timeout: SQLITE_SUBPROCESS_TIMEOUT_MS };
  try {
    await execFileWithInput("sqlite3", [dbPath], execOpts);
    return;
  } catch (error) {
    if (!isCommandMissingError(error, "sqlite3")) {
      throw error;
    }
    const pyScript = [
      "import sqlite3, sys",
      "db_path = sys.argv[1]",
      "sql_script = sys.stdin.read()",
      "conn = sqlite3.connect(db_path)",
      "cur = conn.cursor()",
      "cur.executescript(sql_script)",
      "conn.commit()",
      "conn.close()",
    ].join(";");
    await execFileWithInput("python3", ["-c", pyScript, dbPath], execOpts);
  }
}

function isCommandMissingError(error: unknown, command: string): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const msg = error.message;
  return msg.includes(`spawn ${command} ENOENT`) || msg.includes(`'${command}' not found`);
}

function coerceSqliteValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const serialized = JSON.stringify(parsed);
      if (serialized.length > 4000) {
        return `${serialized.slice(0, 4000)}…`;
      }
      return parsed;
    } catch {
      return trimmed.length > 4000 ? `${trimmed.slice(0, 4000)}…` : trimmed;
    }
  }

  return trimmed.length > 4000 ? `${trimmed.slice(0, 4000)}…` : trimmed;
}

async function resolveStateDbCandidates(): Promise<string[]> {
  const candidates = new Set<string>();
  const home = os.homedir();

  const platformCandidates =
    process.platform === "darwin"
      ? [
          path.join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb"),
          path.join(
            home,
            "Library",
            "Application Support",
            "Cursor Nightly",
            "User",
            "globalStorage",
            "state.vscdb"
          ),
        ]
      : process.platform === "win32"
        ? [
            path.join(home, "AppData", "Roaming", "Cursor", "User", "globalStorage", "state.vscdb"),
            path.join(
              home,
              "AppData",
              "Roaming",
              "Cursor Nightly",
              "User",
              "globalStorage",
              "state.vscdb"
            ),
          ]
        : [
            path.join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb"),
            path.join(home, ".config", "Cursor Nightly", "User", "globalStorage", "state.vscdb"),
          ];

  for (const candidate of platformCandidates) {
    try {
      await fs.access(candidate);
      candidates.add(candidate);
    } catch {}
  }

  return [...candidates].sort();
}

function resolveChatsRoot(): string {
  return path.join(os.homedir(), ".cursor", "chats");
}

function collectRequiredStoreWorkspaceKeys(
  manifest: TranscriptManifestV2,
  selectedConversationKeys: Set<string>
): string[] {
  const keys = new Set<string>();
  for (const [conversationKey, conv] of Object.entries(manifest.conversations)) {
    if (!selectedConversationKeys.has(conversationKey)) {
      continue;
    }
    if (!conv.storeArtifact) {
      continue;
    }
    const storeEntry = manifest.artifacts[conv.storeArtifact];
    const swk = storeEntry?.sourceWorkspaceKey;
    if (typeof swk === "string" && swk.length > 0) {
      keys.add(swk);
    }
  }
  return [...keys].sort((a, b) => a.localeCompare(b));
}

function deriveStoreWorkspaceMapping(
  manifest: TranscriptManifestV2,
  selectedConversationKeys: Set<string>,
  projectMapping: ReadonlyMap<string, ProjectInfo>
): { resolved: Map<string, string>; ambiguousSources: string[] } {
  const targetsBySource = new Map<string, Set<string>>();
  for (const [conversationKey, conv] of Object.entries(manifest.conversations)) {
    if (!selectedConversationKeys.has(conversationKey)) {
      continue;
    }
    if (!conv.storeArtifact) {
      continue;
    }
    const storeEntry = manifest.artifacts[conv.storeArtifact];
    const swk = storeEntry?.sourceWorkspaceKey;
    if (typeof swk !== "string" || swk.length === 0) {
      continue;
    }
    const tp = projectMapping.get(conv.projectKey);
    if (!tp) {
      continue;
    }
    const set = targetsBySource.get(swk) ?? new Set<string>();
    set.add(tp.folderName);
    targetsBySource.set(swk, set);
  }
  const resolved = new Map<string, string>();
  const ambiguousSources: string[] = [];
  for (const [swk, set] of [...targetsBySource.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (set.size === 1) {
      resolved.set(swk, [...set][0]!);
    } else {
      ambiguousSources.push(swk);
    }
  }
  return { resolved, ambiguousSources };
}

async function listChatsWorkspaceKeys(): Promise<string[]> {
  const root = resolveChatsRoot();
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

function isSafeWorkspaceKeySegment(key: string): boolean {
  if (key.length === 0 || key === "." || key === "..") return false;
  if (key.includes("/") || key.includes("\\") || key.includes("\0")) return false;
  return true;
}

async function promptForWorkspaceMapping(
  sourceWorkspaceKeys: string[],
  chatsWorkspaceKeys: string[],
  logger: ReturnType<typeof getLogger>
): Promise<Map<string, string> | null> {
  if (sourceWorkspaceKeys.length === 0) {
    return new Map();
  }

  const mapping = new Map<string, string>();

  for (const src of sourceWorkspaceKeys) {
    const picks: vscode.QuickPickItem[] = [
      ...chatsWorkspaceKeys.map((k) => ({ label: k, description: k })),
      { label: "Enter custom workspace key…", description: "__custom__" },
    ];
    picks.unshift({ label: "(Cancel import)", description: "__cancel__" });

    const selected = await vscode.window.showQuickPick(picks, {
      title: `Map source chats workspace "${src}" to a local ~/.cursor/chats subdirectory`,
      placeHolder: "Select the destination workspace key for store.db restoration",
    });

    if (!selected || selected.description === "__cancel__") {
      logger.appendLine(
        `[${new Date().toISOString()}] Transcript import cancelled during workspace mapping`
      );
      return null;
    }

    if (selected.description === "__custom__") {
      const raw = await vscode.window.showInputBox({
        prompt: `Target workspace key for source "${src}" (single directory name under ~/.cursor/chats/)`,
        validateInput: (v) => {
          if (!v || !isSafeWorkspaceKeySegment(v.trim())) {
            return "Use one non-empty path segment without slashes.";
          }
          return undefined;
        },
      });
      if (raw === undefined) {
        return null;
      }
      mapping.set(src, raw.trim());
    } else if (selected.description) {
      mapping.set(src, selected.description);
    }
  }

  return mapping;
}

async function preflightV2ConversationImport(params: {
  gistData: GistResponse;
  manifest: TranscriptManifestV2;
  conversation: TranscriptBundleConversationEntry;
  targetProject: ProjectInfo;
  workspaceMapping: ReadonlyMap<string, string>;
}): Promise<string[]> {
  const { gistData, manifest, conversation, targetProject, workspaceMapping } = params;
  const errors: string[] = [];

  const artifactIds = [
    ...conversation.transcriptArtifacts,
    conversation.sidebarArtifact,
    ...(conversation.storeArtifact ? [conversation.storeArtifact] : []),
  ];

  for (const artifactId of artifactIds) {
    const entry = manifest.artifacts[artifactId];
    if (!entry) {
      errors.push(`Import preflight failed: Missing manifest entry for "${artifactId}".`);
      continue;
    }

    const gistFile = gistData.files[syncKeyToGistFileName(artifactId)];
    if (!gistFile) {
      errors.push(`Import preflight failed: Bundle file missing for "${artifactId}".`);
      continue;
    }

    let content: Buffer;
    try {
      content = decodeTranscriptArtifact(gistFile.content, entry.encoding);
    } catch {
      errors.push(`Import preflight failed: Failed to decode artifact "${artifactId}".`);
      continue;
    }

    const checksum = computeArtifactChecksum(content);
    if (checksum !== entry.checksum) {
      errors.push(`Import preflight failed: Checksum mismatch for "${artifactId}".`);
    }

    if (entry.kind === "store") {
      const swk = entry.sourceWorkspaceKey;
      if (typeof swk !== "string" || swk.length === 0) {
        errors.push(
          `Import preflight failed: Store "${artifactId}" has no sourceWorkspaceKey; re-export with Cursor Sync or deselect this conversation.`
        );
      } else {
        const mapped = workspaceMapping.get(swk);
        if (typeof mapped !== "string" || mapped.length === 0) {
          errors.push(
            `Import preflight failed: Store "${artifactId}": map source workspace "${swk}" to a local chats key.`
          );
        } else if (!isSafeWorkspaceKeySegment(mapped)) {
          errors.push(
            `Import preflight failed: Store destination workspace key "${mapped}" is not a safe path segment.`
          );
        } else {
          const parent = path.join(resolveChatsRoot(), mapped);
          try {
            await fs.mkdir(parent, { recursive: true });
          } catch {
            errors.push(
              `Import preflight failed: Cannot create or access chats directory "${parent}" for store restore.`
            );
          }
        }
      }
    }
  }

  try {
    await fs.access(targetProject.fullPath);
  } catch {
    errors.push(`Import preflight failed: Target project directory missing: ${targetProject.fullPath}.`);
  }

  try {
    await fs.mkdir(resolveChatsRoot(), { recursive: true });
  } catch {
    errors.push(`Import preflight failed: Cannot access chats root ${resolveChatsRoot()}.`);
  }

  return errors;
}

function buildImportRestoreReportFromOperations(operations: RestoreOperation[]): ImportRestoreReport {
  const transcript = operations.filter((o) => o.kind === "transcript").length;
  const store = operations.filter((o) => o.kind === "store").length;
  const sidebar = operations.filter((o) => o.kind === "sidebar").length;
  return {
    transcriptWritten: transcript,
    storeWritten: store,
    sidebarWritten: sidebar,
    stateDbMerged: 0,
    stateDbSkippedNoPayload: 0,
    stateDbSkippedNoDb: 0,
    statePartial: false,
    warnings: [],
  };
}

interface StateRestoreOutcome {
  stateDbMerged: number;
  stateDbSkippedNoPayload: number;
  stateDbSkippedNoDb: number;
  statePartial: boolean;
  warnings: string[];
}

function mergeStateOutcomeIntoReport(
  base: ImportRestoreReport,
  state: StateRestoreOutcome
): ImportRestoreReport {
  return {
    ...base,
    stateDbMerged: state.stateDbMerged,
    stateDbSkippedNoPayload: state.stateDbSkippedNoPayload,
    stateDbSkippedNoDb: state.stateDbSkippedNoDb,
    statePartial: base.statePartial || state.statePartial,
    warnings: [...base.warnings, ...state.warnings],
  };
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function parseComposerHeadersBlob(raw: string | undefined): {
  allComposers: Array<Record<string, unknown>>;
} {
  if (!raw) {
    return { allComposers: [] };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Array.isArray((parsed as Record<string, unknown>).allComposers)
    ) {
      return {
        allComposers: (parsed as { allComposers: Array<Record<string, unknown>> }).allComposers,
      };
    }
  } catch {}
  return { allComposers: [] };
}

function getComposerId(record: Record<string, unknown>): string {
  const id = record.composerId;
  return typeof id === "string" && id.length > 0 ? id : "";
}

function mergeComposerHeadersAdditive(
  existing: { allComposers: Array<Record<string, unknown>> },
  imported: Record<string, unknown>
): { allComposers: Array<Record<string, unknown>> } {
  const byId = new Map<string, Record<string, unknown>>();
  for (const c of existing.allComposers) {
    const id = getComposerId(c);
    if (id) {
      byId.set(id, { ...c });
    }
  }
  const importedList = Array.isArray(imported.allComposers) ? imported.allComposers : [];
  for (const c of importedList) {
    if (!c || typeof c !== "object" || Array.isArray(c)) {
      continue;
    }
    const rec = c as Record<string, unknown>;
    const id = getComposerId(rec);
    if (!id || byId.has(id)) {
      continue;
    }
    byId.set(id, { ...rec });
  }
  return { allComposers: [...byId.values()] };
}

function mergeComposerHeadersChain(
  existingRaw: string | undefined,
  importedPayloads: Array<Record<string, unknown>>
): { allComposers: Array<Record<string, unknown>> } {
  let acc = parseComposerHeadersBlob(existingRaw);
  for (const imp of importedPayloads) {
    acc = mergeComposerHeadersAdditive(acc, imp);
  }
  return acc;
}

function extractComposerHeadersPayload(
  parsed: Record<string, unknown>
): Record<string, unknown> | undefined {
  const ch = parsed.composerHeaders;
  if (ch && typeof ch === "object" && !Array.isArray(ch)) {
    return ch as Record<string, unknown>;
  }
  const cr = parsed.composerHeadersRestore;
  if (cr && typeof cr === "object" && !Array.isArray(cr)) {
    return cr as Record<string, unknown>;
  }
  const rows = parsed.matchedItemTableRows;
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        continue;
      }
      const rec = row as Record<string, unknown>;
      if (rec.key !== "composer.composerHeaders") {
        continue;
      }
      const v = rec.value;
      if (typeof v === "string") {
        const t = v.trim();
        if (t.endsWith("…") || t.endsWith("...")) {
          return undefined;
        }
        try {
          const parsedInner = JSON.parse(t) as unknown;
          if (parsedInner && typeof parsedInner === "object" && !Array.isArray(parsedInner)) {
            return parsedInner as Record<string, unknown>;
          }
        } catch {
          return undefined;
        }
      }
      if (v && typeof v === "object" && !Array.isArray(v)) {
        return v as Record<string, unknown>;
      }
    }
  }
  return undefined;
}

function extractComposerDataPayload(
  parsed: Record<string, unknown>
): Record<string, unknown> | undefined {
  const direct = parsed.composerData;
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    return direct as Record<string, unknown>;
  }
  const restore = parsed.composerDataRestore;
  if (restore && typeof restore === "object" && !Array.isArray(restore)) {
    return restore as Record<string, unknown>;
  }
  const rows = parsed.matchedItemTableRows;
  if (!Array.isArray(rows)) {
    return undefined;
  }
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      continue;
    }
    const rec = row as Record<string, unknown>;
    if (rec.key !== "composer.composerData") {
      continue;
    }
    const v = rec.value;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
    if (typeof v !== "string") {
      continue;
    }
    const t = v.trim();
    if (t.endsWith("…") || t.endsWith("...")) {
      return undefined;
    }
    try {
      const parsedInner = JSON.parse(t) as unknown;
      if (parsedInner && typeof parsedInner === "object" && !Array.isArray(parsedInner)) {
        return parsedInner as Record<string, unknown>;
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function mergeComposerDataAdditive(
  existingRaw: string | undefined,
  importedPayloads: Array<Record<string, unknown>>
): Record<string, unknown> {
  const parseBlob = (raw: string | undefined): Record<string, unknown> => {
    if (!raw || raw.trim().length === 0) {
      return {};
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {}
    return {};
  };

  const mergeComposerArray = (
    baseValue: unknown,
    importedValue: unknown
  ): Array<Record<string, unknown>> | undefined => {
    if (!Array.isArray(baseValue) || !Array.isArray(importedValue)) {
      return undefined;
    }
    const byId = new Map<string, Record<string, unknown>>();
    for (const entry of baseValue) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const rec = entry as Record<string, unknown>;
      const id = getComposerId(rec);
      if (id) {
        byId.set(id, { ...rec });
      }
    }
    for (const entry of importedValue) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const rec = entry as Record<string, unknown>;
      const id = getComposerId(rec);
      if (!id || byId.has(id)) {
        continue;
      }
      byId.set(id, { ...rec });
    }
    return [...byId.values()];
  };

  let merged = parseBlob(existingRaw);
  for (const imported of importedPayloads) {
    const next: Record<string, unknown> = { ...merged };
    for (const [key, value] of Object.entries(imported)) {
      if (!(key in next)) {
        next[key] = value;
        continue;
      }
      const mergedArray = mergeComposerArray(next[key], value);
      if (mergedArray) {
        next[key] = mergedArray;
      }
    }
    merged = next;
  }
  return merged;
}

function deriveComposerHeadersPayloadFromSidebarSnapshot(
  parsed: Record<string, unknown>
): Record<string, unknown> | undefined {
  const conversationId = parsed.conversationId;
  if (typeof conversationId !== "string" || conversationId.trim().length === 0) {
    return undefined;
  }
  const title = typeof parsed.title === "string" && parsed.title.trim().length > 0
    ? parsed.title
    : conversationId;
  const subtitle = typeof parsed.subtitle === "string" ? parsed.subtitle : "";
  const rawTimestamp = parsed.lastUpdatedAt;
  const timestamp =
    typeof rawTimestamp === "string" && rawTimestamp.trim().length > 0
      ? rawTimestamp
      : new Date().toISOString();
  return {
    allComposers: [
      {
        composerId: conversationId,
        name: title,
        subtitle,
        lastUpdatedAt: timestamp,
        lastOpenedAt: timestamp,
        createdAt: timestamp,
        hasUnreadMessages: false,
        isArchived: false,
        isDraft: false,
      },
    ],
  };
}

async function resolveSidebarImportStateDbPaths(
  parsed: Record<string, unknown>
): Promise<{ paths: string[]; usedFallback: boolean }> {
  const sp = parsed.stateDbPath;
  if (typeof sp === "string" && sp.length > 0) {
    try {
      await fs.access(sp);
      return { paths: [sp], usedFallback: false };
    } catch {
      const candidates = await resolveStateDbCandidates();
      if (candidates.length > 0) {
        return { paths: [candidates[0]!], usedFallback: true };
      }
      return { paths: [], usedFallback: false };
    }
  }
  const candidates = await resolveStateDbCandidates();
  return { paths: candidates.length > 0 ? [candidates[0]!] : [], usedFallback: false };
}

async function applySidebarStateRestoration(
  context: vscode.ExtensionContext,
  sidebarOps: RestoreOperation[],
  logger: ReturnType<typeof getLogger>
): Promise<StateRestoreOutcome> {
  const outcome: StateRestoreOutcome = {
    stateDbMerged: 0,
    stateDbSkippedNoPayload: 0,
    stateDbSkippedNoDb: 0,
    statePartial: false,
    warnings: [],
  };

  type Agg = {
    headerPayloads: Array<Record<string, unknown>>;
    dataPayloads: Array<Record<string, unknown>>;
    conversationIds: string[];
  };
  const byDb = new Map<string, Agg>();

  for (const op of sidebarOps) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(op.content.toString("utf-8")) as Record<string, unknown>;
    } catch {
      outcome.warnings.push(`Sidebar ${op.conversationId ?? "?"}: invalid JSON; state.vscdb unchanged.`);
      outcome.statePartial = true;
      continue;
    }

    const headersPayload = extractComposerHeadersPayload(parsed);
    const effectiveHeadersPayload =
      headersPayload ?? deriveComposerHeadersPayloadFromSidebarSnapshot(parsed);
    const dataPayload = extractComposerDataPayload(parsed);
    if (!effectiveHeadersPayload && !dataPayload) {
      outcome.stateDbSkippedNoPayload += 1;
      continue;
    }

    const { paths, usedFallback } = await resolveSidebarImportStateDbPaths(parsed);
    if (paths.length === 0) {
      outcome.stateDbSkippedNoDb += 1;
      outcome.warnings.push(
        `Sidebar ${op.conversationId ?? "?"}: state.vscdb not found; only sidebar JSON was written.`
      );
      outcome.statePartial = true;
      continue;
    }

    if (typeof parsed.stateDbPath === "string" && parsed.stateDbPath.length > 0 && usedFallback) {
      outcome.warnings.push(
        `Sidebar ${op.conversationId ?? "?"}: exported stateDbPath unavailable; used default state.vscdb (partial).`
      );
      outcome.statePartial = true;
    }

    const dbPath = paths[0]!;
    const agg = byDb.get(dbPath) ?? {
      headerPayloads: [],
      dataPayloads: [],
      conversationIds: [],
    };
    if (effectiveHeadersPayload) {
      agg.headerPayloads.push(effectiveHeadersPayload);
    }
    if (dataPayload) {
      agg.dataPayloads.push(dataPayload);
    }
    if (op.conversationId) {
      agg.conversationIds.push(op.conversationId);
    }
    byDb.set(dbPath, agg);
  }

  for (const [dbPath, agg] of byDb) {
    let existingHeadersRaw: string | undefined;
    let existingDataRaw: string | undefined;
    try {
      const rows = await querySqliteRows(
        dbPath,
        "SELECT key, value FROM ItemTable WHERE key IN ('composer.composerHeaders', 'composer.composerData');"
      );
      for (const row of rows) {
        const key = String(row.key ?? "");
        const value = row.value;
        if (key === "composer.composerHeaders") {
          if (typeof value === "string") {
            existingHeadersRaw = value;
          } else if (value != null && typeof value === "object") {
            existingHeadersRaw = JSON.stringify(value);
          }
        }
        if (key === "composer.composerData") {
          if (typeof value === "string") {
            existingDataRaw = value;
          } else if (value != null && typeof value === "object") {
            existingDataRaw = JSON.stringify(value);
          }
        }
      }
    } catch (error) {
      outcome.warnings.push(
        isExecFileTimeoutError(error)
          ? `State DB ${dbPath}: SQLite timed out (database may be locked); merge skipped.`
          : `State DB ${dbPath}: read failed; merge skipped.`
      );
      outcome.statePartial = true;
      continue;
    }

    const mergedHeaders = mergeComposerHeadersChain(existingHeadersRaw, agg.headerPayloads);
    const mergedHeadersJson = JSON.stringify(mergedHeaders);
    const mergedData = mergeComposerDataAdditive(existingDataRaw, agg.dataPayloads);
    const mergedDataJson = JSON.stringify(mergedData);

    const { entries: backupEntries } = await createBackup(context, [dbPath]);
    try {
      const escapedHeaders = escapeSqlLiteral(mergedHeadersJson);
      const headerScript =
        `UPDATE ItemTable SET value = '${escapedHeaders}' WHERE key = 'composer.composerHeaders';\n` +
        `INSERT INTO ItemTable (key, value) SELECT 'composer.composerHeaders', '${escapedHeaders}' WHERE NOT EXISTS (SELECT 1 FROM ItemTable WHERE key = 'composer.composerHeaders');\n`;
      const dataScript =
        agg.dataPayloads.length > 0
          ? (() => {
              const escapedData = escapeSqlLiteral(mergedDataJson);
              return (
                `UPDATE ItemTable SET value = '${escapedData}' WHERE key = 'composer.composerData';\n` +
                `INSERT INTO ItemTable (key, value) SELECT 'composer.composerData', '${escapedData}' WHERE NOT EXISTS (SELECT 1 FROM ItemTable WHERE key = 'composer.composerData');\n`
              );
            })()
          : "";
      const script = `BEGIN IMMEDIATE;\n${headerScript}${dataScript}COMMIT;\n`;
      await runSqliteScript(dbPath, script);
      outcome.stateDbMerged += 1;
      logger.appendLine(
        `[${new Date().toISOString()}] Merged composer state in ${dbPath} for ${agg.conversationIds.join(",")}`
      );
    } catch (error) {
      await rollbackFromBackup(backupEntries);
      outcome.warnings.push(
        `State DB ${dbPath}: write failed (${error instanceof Error ? error.message : String(error)}); rolled back.`
      );
      outcome.statePartial = true;
    }
  }

  return outcome;
}

async function findStoreDbForConversation(
  conversationId: string
): Promise<{ absolutePath: string; workspaceKey: string } | undefined> {
  let workspaceEntries: import("node:fs").Dirent[];
  try {
    workspaceEntries = await fs.readdir(resolveChatsRoot(), { withFileTypes: true });
  } catch {
    return undefined;
  }

  const sortedWorkspaceEntries = workspaceEntries
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const workspaceEntry of sortedWorkspaceEntries) {
    const candidate = path.join(resolveChatsRoot(), workspaceEntry.name, conversationId, "store.db");
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) {
        return {
          absolutePath: candidate,
          workspaceKey: workspaceEntry.name,
        };
      }
    } catch {}
  }

  return undefined;
}

function resolveArtifactImportPath(
  targetProject: ProjectInfo,
  artifactEntry: TranscriptBundleArtifactEntry,
  workspaceMapping: ReadonlyMap<string, string>
): string {
  if (artifactEntry.kind === "transcript") {
    const relativePath =
      artifactEntry.sourceRelativePath ??
      `${artifactEntry.conversationId}/${path.basename(artifactEntry.conversationId)}.jsonl`;
    return path.join(targetProject.fullPath, "agent-transcripts", ...relativePath.split("/"));
  }

  if (artifactEntry.kind === "store") {
    const swk = artifactEntry.sourceWorkspaceKey;
    const mapped =
      typeof swk === "string" && swk.length > 0 ? workspaceMapping.get(swk) ?? "" : "";
    return path.join(resolveChatsRoot(), mapped, artifactEntry.conversationId, "store.db");
  }

  return path.join(
    targetProject.fullPath,
    "agent-transcripts",
    artifactEntry.conversationId,
    "cursor-sidebar-metadata.json"
  );
}

function toSortedRecord<T>(entries: Array<[string, T]>): Record<string, T> {
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
}

export const __transcriptsTestUtils = {
  extractComposerHeadersPayload,
  extractComposerDataPayload,
  mergeComposerHeadersChain,
  mergeComposerDataAdditive,
};
