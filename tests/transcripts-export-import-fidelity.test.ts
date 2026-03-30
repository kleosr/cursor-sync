import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bundleArtifactSyncKey,
  syncKeyToGistFileName,
} from "../src/transcript-bundle.js";

const createGistMock = vi.fn();
const getGistMock = vi.fn();
const requireTokenMock = vi.fn();
const getTokenMock = vi.fn();
const withRetryMock = vi.fn(async <T>(fn: () => Promise<T>) => fn());
const appendLineMock = vi.fn();
const showInformationMessageMock = vi.fn();
const showWarningMessageMock = vi.fn();
const showErrorMessageMock = vi.fn();
const showInputBoxMock = vi.fn();
const showQuickPickMock = vi.fn();
const clipboardWriteTextMock = vi.fn();
let mockedHomeDir = "";

const configurationValues: Record<string, unknown> = {
  "transcripts.enabled": true,
  "transcripts.maxFileSizeKB": 2048,
};

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => mockedHomeDir,
  };
});

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: <T>(key: string, defaultValue?: T) =>
        (configurationValues[key] as T | undefined) ?? defaultValue,
      update: vi.fn(),
    }),
  },
  window: {
    createOutputChannel: () => ({
      appendLine: appendLineMock,
      show: vi.fn(),
      dispose: vi.fn(),
    }),
    showInformationMessage: showInformationMessageMock,
    showWarningMessage: showWarningMessageMock,
    showErrorMessage: showErrorMessageMock,
    showInputBox: showInputBoxMock,
    showQuickPick: showQuickPickMock,
    withProgress: async (_options: unknown, task: () => Promise<unknown>) => task(),
  },
  env: {
    clipboard: {
      writeText: clipboardWriteTextMock,
    },
  },
  ProgressLocation: {
    Notification: 15,
  },
  ConfigurationTarget: {
    Global: 1,
  },
}));

vi.mock("../src/gist.js", () => ({
  GistClient: class {
    createGist = createGistMock;
    getGist = getGistMock;
  },
}));

vi.mock("../src/auth.js", () => ({
  requireToken: requireTokenMock,
  getToken: getTokenMock,
}));

vi.mock("../src/retry.js", () => ({
  withRetry: withRetryMock,
}));

vi.mock("../src/diagnostics.js", () => ({
  getLogger: () => ({
    appendLine: appendLineMock,
    show: vi.fn(),
    dispose: vi.fn(),
  }),
}));

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(testsDir, "fixtures", "transcripts-bundle-v2");
const transcriptFixture = readFileSync(path.join(fixtureDir, "conversation.jsonl"), "utf-8");
const sidebarFixture = readFileSync(path.join(fixtureDir, "sidebar-snapshot.json"), "utf-8");

function transcriptSyncKey(projectKey: string, relativePath: string): string {
  return `transcripts/${projectKey}/${relativePath}`;
}

function transcriptGistFileName(projectKey: string, relativePath: string): string {
  return transcriptSyncKey(projectKey, relativePath).replace(/\//g, "--");
}

function transcriptArtifactSyncKey(projectKey: string, relativePath: string): string {
  const conversationId = relativePath.split("/")[0] ?? relativePath;
  const scopedRelativePath = relativePath.includes("/")
    ? relativePath.split("/").slice(1).join("/")
    : relativePath;
  return bundleArtifactSyncKey(projectKey, conversationId, "transcript", scopedRelativePath);
}

function buildManifest(options: {
  schemaVersion: 1 | 2;
  projectKey: string;
  relativePath: string;
  content: string;
}) {
  const { schemaVersion, projectKey, relativePath, content } = options;
  const syncKey = transcriptSyncKey(projectKey, relativePath);
  const checksum = crypto.createHash("sha256").update(content).digest("hex");
  const base = {
    schemaVersion,
    type: "agent-transcripts" as const,
    createdAt: "2026-03-30T12:00:00.000Z",
    sourceMachineId: "source-machine",
    sourceOS: "linux",
    sourceProjects: {
      [projectKey]: {
        folderName: projectKey,
        fileCount: 1,
      },
    },
    files: {
      [syncKey]: {
        projectKey,
        checksum,
        sizeBytes: Buffer.byteLength(content, "utf-8"),
      },
    },
  };

  if (schemaVersion === 1) {
    return base;
  }

  const transcriptArtifactId = transcriptArtifactSyncKey(projectKey, relativePath);
  const conversationId = relativePath.split("/")[0] ?? relativePath;
  const transcriptSize = Buffer.byteLength(content, "utf-8");
  const sidebarArtifactId = bundleArtifactSyncKey(
    projectKey,
    conversationId,
    "sidebar",
    "sidebar-metadata.json"
  );
  const sidebarChecksum = crypto.createHash("sha256").update(sidebarFixture).digest("hex");

  return {
    schemaVersion: 2 as const,
    type: "agent-transcripts" as const,
    createdAt: base.createdAt,
    sourceMachineId: base.sourceMachineId,
    sourceOS: base.sourceOS,
    sourceProjects: {
      [projectKey]: {
        folderName: projectKey,
        fileCount: 1,
        conversationCount: 1,
        artifactCount: 2,
      },
    },
    artifacts: {
      [transcriptArtifactId]: {
        projectKey,
        conversationId,
        kind: "transcript",
        checksum,
        sizeBytes: transcriptSize,
        contentType: "application/x-jsonlines",
        sourceRelativePath: relativePath,
      },
      [sidebarArtifactId]: {
        projectKey,
        conversationId,
        kind: "sidebar",
        checksum: sidebarChecksum,
        sizeBytes: Buffer.byteLength(sidebarFixture, "utf-8"),
        contentType: "application/json",
      },
    },
    conversations: {
      [`${projectKey}:${conversationId}`]: {
        projectKey,
        conversationId,
        title: "Conversation 123",
        subtitle: "3 messages · user, assistant, tool",
        previewText: "tool-result",
        lastUpdatedAt: base.createdAt,
        transcriptArtifacts: [transcriptArtifactId],
        sidebarArtifact: sidebarArtifactId,
        warnings: [],
      },
    },
    warnings: [],
    fidelity: {
      transcriptBytes: "exact",
      storeSnapshots: ["stores/source-project/conversation-123/store.db.json"],
      sidebarSnapshots: ["sidebar/source-project/composer-headers.json"],
    },
    limitations: [
      "Current import ignores store.db snapshots.",
      "Current import ignores sidebar metadata snapshots.",
    ],
  };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("transcript export and import fidelity", () => {
  let tmpRoot: string;
  let extensionContext: { globalStorageUri: { fsPath: string } };

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-transcript-fidelity-"));
    mockedHomeDir = tmpRoot;
    createGistMock.mockReset();
    getGistMock.mockReset();
    requireTokenMock.mockReset();
    getTokenMock.mockReset();
    withRetryMock.mockClear();
    appendLineMock.mockReset();
    showInformationMessageMock.mockReset();
    showWarningMessageMock.mockReset();
    showErrorMessageMock.mockReset();
    showInputBoxMock.mockReset();
    showQuickPickMock.mockReset();
    clipboardWriteTextMock.mockReset();
    configurationValues["transcripts.enabled"] = true;
    configurationValues["transcripts.maxFileSizeKB"] = 2048;
    requireTokenMock.mockResolvedValue("ghp_export_token");
    getTokenMock.mockResolvedValue("ghp_import_token");
    extensionContext = {
      globalStorageUri: {
        fsPath: path.join(tmpRoot, ".cursor-sync-global-storage"),
      },
    };
    await fs.mkdir(extensionContext.globalStorageUri.fsPath, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    vi.resetModules();
  });

  it("exports exact transcript bytes with a checksum-backed manifest", async () => {
    const projectKey = "source-project";
    const relativePath = "conversation-123/conversation-123.jsonl";
    const transcriptPath = path.join(
      tmpRoot,
      ".cursor",
      "projects",
      projectKey,
      "agent-transcripts",
      "conversation-123",
      "conversation-123.jsonl"
    );

    await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
    await fs.writeFile(transcriptPath, transcriptFixture, "utf-8");

    showQuickPickMock
      .mockImplementationOnce(async (items: Array<{ description?: string }>) =>
        items.filter((item) => item.description === projectKey)
      )
      .mockImplementationOnce(async (items: Array<{ label?: string }>) =>
        items.filter((item) => item.label === relativePath)
      );
    showWarningMessageMock.mockResolvedValue("Export");
    showInformationMessageMock.mockResolvedValue("Copy URL");
    createGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-export",
        html_url: "https://gist.github.com/example/gist-export",
        description: "Cursor Sync - Agent Transcripts Export",
        files: {},
        created_at: "2026-03-30T12:00:00.000Z",
        updated_at: "2026-03-30T12:00:00.000Z",
      },
    });

    const { executeExportTranscripts } = await import("../src/transcripts.js");
    await executeExportTranscripts(extensionContext as never);
    await flushMicrotasks();

    expect(createGistMock).toHaveBeenCalledTimes(1);
    const [gistFiles] = createGistMock.mock.calls[0] as [
      Record<string, { content: string }>,
      string,
    ];
    const transcriptArtifactId = transcriptArtifactSyncKey(projectKey, relativePath);
    const gistFileName = syncKeyToGistFileName(transcriptArtifactId);
    const manifest = JSON.parse(gistFiles["transcript-manifest.json"].content) as {
      schemaVersion: number;
      type: string;
      sourceProjects: Record<string, { fileCount: number }>;
      artifacts: Record<string, { checksum: string; sizeBytes: number; kind: string }>;
    };
    const expectedChecksum = crypto
      .createHash("sha256")
      .update(transcriptFixture)
      .digest("hex");

    expect(gistFiles[gistFileName].content).toBe(transcriptFixture);
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.type).toBe("agent-transcripts");
    expect(manifest.sourceProjects[projectKey].fileCount).toBe(1);
    expect(manifest.artifacts[transcriptArtifactId].kind).toBe("transcript");
    expect(manifest.artifacts[transcriptArtifactId].checksum).toBe(expectedChecksum);
    expect(manifest.artifacts[transcriptArtifactId].sizeBytes).toBe(
      Buffer.byteLength(transcriptFixture, "utf-8")
    );
    expect(clipboardWriteTextMock).toHaveBeenCalledWith(
      "https://gist.github.com/example/gist-export"
    );
  });

  it("imports a v2-style bundle while preserving user, assistant, and tool transcript bytes", async () => {
    const sourceProjectKey = "source-project";
    const targetProjectKey = "target-project";
    const relativePath = "conversation-123/conversation-123.jsonl";
    const targetProjectDir = path.join(
      tmpRoot,
      ".cursor",
      "projects",
      targetProjectKey
    );

    await fs.mkdir(targetProjectDir, { recursive: true });

    const manifest = buildManifest({
      schemaVersion: 2,
      projectKey: sourceProjectKey,
      relativePath,
      content: transcriptFixture,
    });

    getGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-import-v2",
        html_url: "https://gist.github.com/example/gist-import-v2",
        description: "Cursor Sync - Agent Transcripts Export",
        files: {
          "transcript-manifest.json": { content: JSON.stringify(manifest, null, 2) },
          [syncKeyToGistFileName(transcriptArtifactSyncKey(sourceProjectKey, relativePath))]: {
            content: transcriptFixture,
          },
          [syncKeyToGistFileName(
            bundleArtifactSyncKey(sourceProjectKey, "conversation-123", "sidebar", "sidebar-metadata.json")
          )]: { content: sidebarFixture },
        },
        created_at: "2026-03-30T12:00:00.000Z",
        updated_at: "2026-03-30T12:00:00.000Z",
      },
    });

    showInputBoxMock.mockResolvedValue("abcdefabcdefabcdefab");
    showQuickPickMock
      .mockImplementationOnce(
        async (items: Array<{ description?: string }>) =>
          items.find((item) => item.description === targetProjectKey)
      )
      .mockImplementationOnce(async (items: Array<{ label?: string }>) => items);
    showWarningMessageMock.mockResolvedValue("Import");

    const { executeImportTranscripts } = await import("../src/transcripts.js");
    await executeImportTranscripts(extensionContext as never);

    const importedPath = path.join(
      targetProjectDir,
      "agent-transcripts",
      "conversation-123",
      "conversation-123.jsonl"
    );
    const importedContent = await fs.readFile(importedPath, "utf-8");

    expect(importedContent).toBe(transcriptFixture);
    expect(showErrorMessageMock).not.toHaveBeenCalled();
    expect(showInformationMessageMock).toHaveBeenCalledWith(
      expect.stringContaining("Transcript import complete: 2 artifact(s) written"),
    );
  });

  it("keeps schemaVersion 1 transcript imports working", async () => {
    const sourceProjectKey = "legacy-project";
    const targetProjectKey = "legacy-target";
    const relativePath = "conversation-123/conversation-123.jsonl";
    const targetProjectDir = path.join(
      tmpRoot,
      ".cursor",
      "projects",
      targetProjectKey
    );

    await fs.mkdir(targetProjectDir, { recursive: true });

    const manifest = buildManifest({
      schemaVersion: 1,
      projectKey: sourceProjectKey,
      relativePath,
      content: transcriptFixture,
    });

    getGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-import-v1",
        html_url: "https://gist.github.com/example/gist-import-v1",
        description: "Cursor Sync - Agent Transcripts Export",
        files: {
          "transcript-manifest.json": { content: JSON.stringify(manifest, null, 2) },
          [transcriptGistFileName(sourceProjectKey, relativePath)]: {
            content: transcriptFixture,
          },
          [syncKeyToGistFileName(
            bundleArtifactSyncKey(sourceProjectKey, "conversation-123", "sidebar", "sidebar-metadata.json")
          )]: { content: sidebarFixture },
        },
        created_at: "2026-03-30T12:00:00.000Z",
        updated_at: "2026-03-30T12:00:00.000Z",
      },
    });

    showInputBoxMock.mockResolvedValue("12345123451234512345");
    showQuickPickMock
      .mockImplementationOnce(
        async (items: Array<{ description?: string }>) =>
          items.find((item) => item.description === targetProjectKey)
      )
      .mockImplementationOnce(async (items: Array<{ description?: string }>) =>
        items.filter(
          (item) =>
            item.description ===
            path.join(targetProjectDir, "agent-transcripts", "conversation-123", "conversation-123.jsonl")
        )
      );
    showWarningMessageMock.mockResolvedValue("Import");

    const { executeImportTranscripts } = await import("../src/transcripts.js");
    await executeImportTranscripts(extensionContext as never);

    const importedPath = path.join(
      targetProjectDir,
      "agent-transcripts",
      "conversation-123",
      "conversation-123.jsonl"
    );
    expect(await fs.readFile(importedPath, "utf-8")).toBe(transcriptFixture);
    expect(showErrorMessageMock).not.toHaveBeenCalled();
  });

  it("reports a missing transcript manifest before writing files", async () => {
    const targetProjectKey = "target-project";
    await fs.mkdir(path.join(tmpRoot, ".cursor", "projects", targetProjectKey), {
      recursive: true,
    });

    getGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-missing-manifest",
        html_url: "https://gist.github.com/example/gist-missing-manifest",
        description: "Cursor Sync - Agent Transcripts Export",
        files: {
          [transcriptGistFileName("source-project", "conversation-123/conversation-123.jsonl")]: {
            content: transcriptFixture,
          },
        },
        created_at: "2026-03-30T12:00:00.000Z",
        updated_at: "2026-03-30T12:00:00.000Z",
      },
    });

    showInputBoxMock.mockResolvedValue("fedcbafedcbafedcbafe");

    const { executeImportTranscripts } = await import("../src/transcripts.js");
    await executeImportTranscripts(extensionContext as never);

    expect(showErrorMessageMock).toHaveBeenCalledWith(
      "Import failed: transcript-manifest.json not found. This Gist may not contain exported transcripts."
    );
  });
});
