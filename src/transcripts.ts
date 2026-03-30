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

  await previewAndApplyImportPlan(
    context,
    selectedOperations,
    "Import transcript files",
    logger,
    {
      sidebarRestoreStagedOnly: false,
    }
  );
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
        "sidebar metadata staged only",
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
  const operations: RestoreOperation[] = [];
  const validationErrors: string[] = [];
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
        validationErrors.push(`Manifest is missing artifact metadata for ${artifactId}.`);
        continue;
      }

      const gistFile = gistData.files[syncKeyToGistFileName(artifactId)];
      if (!gistFile) {
        validationErrors.push(`Bundle is missing ${artifactId}.`);
        continue;
      }

      const content = decodeTranscriptArtifact(gistFile.content, artifactEntry.encoding);
      const checksum = computeArtifactChecksum(content);
      if (checksum !== artifactEntry.checksum) {
        validationErrors.push(`Checksum mismatch for ${artifactId}.`);
        continue;
      }

      operations.push({
        absolutePath: resolveArtifactImportPath(targetProject, artifactEntry),
        content,
        checksum,
        syncKey: artifactId,
        kind: artifactEntry.kind,
        conversationId: artifactEntry.conversationId,
      });

      if (artifactEntry.kind === "sidebar") {
        stagedWarnings.add(
          `${artifactEntry.conversationId}: sidebar metadata will be restored as JSON only; state.vscdb will not be modified.`
        );
      }
    }

    for (const warning of conversation.warnings) {
      stagedWarnings.add(`${conversation.conversationId}: ${warning}`);
    }
  }

  if (validationErrors.length > 0) {
    vscode.window.showErrorMessage(
      `Import failed: ${validationErrors.slice(0, 3).join(" ")}`
    );
    return;
  }

  if (operations.length === 0) {
    vscode.window.showInformationMessage("No bundle artifacts to restore after selection.");
    return;
  }

  await previewAndApplyImportPlan(
    context,
    operations,
    "Import conversation bundle",
    logger,
    {
      sidebarRestoreStagedOnly: true,
      warnings: [...stagedWarnings].sort(),
    }
  );
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
    sidebarRestoreStagedOnly: boolean;
    warnings?: string[];
  }
): Promise<void> {
  const preview = await previewRestoreOperations(operations);

  if (preview.newFiles.length === 0 && preview.conflicts.length === 0) {
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
    const choice = await vscode.window.showWarningMessage(
      `${actionLabel}: ${summary}. Continue?`,
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

  const warningSuffix =
    options.warnings && options.warnings.length > 0
      ? ` Warnings: ${options.warnings.slice(0, 3).join(" ")}`
      : "";
  const sidebarSuffix = options.sidebarRestoreStagedOnly
    ? " Sidebar metadata was restored as JSON sidecars only."
    : "";

  vscode.window.showInformationMessage(
    `Transcript import complete: ${result.writtenCount} artifact(s) written, ${preview.unchanged.length} unchanged, ` +
      `${conflictPolicy === "skip" ? preview.conflicts.length : 0} conflict(s) skipped.${sidebarSuffix}${warningSuffix}`
  );
  logger.appendLine(
    `[${new Date().toISOString()}] Transcript import succeeded: ${result.writtenCount} artifacts`
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
    try {
      await fs.access(operation.absolutePath);
      existingPaths.push(operation.absolutePath);
    } catch {
      createdPaths.push(operation.absolutePath);
    }
  }

  const { entries: backupEntries } = await createBackup(context, existingPaths);
  let writtenCount = 0;

  for (const operation of operations) {
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
    warnings: [...conversationState.warnings].sort(),
  };
}

async function extractSidebarStateEvidence(
  conversationId: string
): Promise<SidebarStateEvidence | undefined> {
  const stateDbCandidates = await resolveStateDbCandidates();
  const escapedConversationId = conversationId.replace(/'/g, "''");

  for (const stateDbPath of stateDbCandidates) {
    const matchedItemTableRows = await querySqliteRows(
      stateDbPath,
      `SELECT key, value FROM ItemTable WHERE value LIKE '%${escapedConversationId}%' LIMIT 10;`
    );
    const matchedCursorDiskRows = await querySqliteRows(
      stateDbPath,
      `SELECT key, value FROM cursorDiskKV WHERE key LIKE '%${escapedConversationId}%' OR value LIKE '%${escapedConversationId}%' LIMIT 10;`
    );
    const composerSummaryRows = await querySqliteRows(
      stateDbPath,
      "SELECT key, length(value) AS valueLength FROM ItemTable WHERE key IN ('composer.composerHeaders', 'composer.composerData') LIMIT 5;"
    );

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
    const { stdout } = await execFile("sqlite3", ["-json", dbPath, sql]);
    const trimmed = stdout.trim();
    if (!trimmed) {
      return [];
    }

    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
      : [];
  } catch {
    return [];
  }
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
  artifactEntry: TranscriptBundleArtifactEntry
): string {
  if (artifactEntry.kind === "transcript") {
    const relativePath =
      artifactEntry.sourceRelativePath ??
      `${artifactEntry.conversationId}/${path.basename(artifactEntry.conversationId)}.jsonl`;
    return path.join(targetProject.fullPath, "agent-transcripts", ...relativePath.split("/"));
  }

  if (artifactEntry.kind === "store") {
    return path.join(
      resolveChatsRoot(),
      targetProject.folderName,
      artifactEntry.conversationId,
      "store.db"
    );
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
