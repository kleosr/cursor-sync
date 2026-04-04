import * as path from "node:path";
import * as vscode from "vscode";
import * as os from "os";
import * as fs from "node:fs/promises";

const VIEW_ID = "cursorSync.transcriptBrowser";
const FILE_CONTEXT_VALUE = "cursorSyncTranscriptFile";

// Represents a Cursor project directory under ~/.cursor/projects/
class TranscriptProjectItem extends vscode.TreeItem {
  constructor(readonly projectName: string, readonly projectPath: string) {
    // Human-friendly label derived from the folder name
    super(humanLabel(projectName), vscode.TreeItemCollapsibleState.Expanded);
    this.description = projectPath;
    this.contextValue = "cursorSyncTranscriptProject";
    this.iconPath = new vscode.ThemeIcon("folder-root");
  }
}

class TranscriptFileItem extends vscode.TreeItem {
  constructor(readonly uri: vscode.Uri, readonly projectPath: string) {
    super(path.basename(uri.fsPath), vscode.TreeItemCollapsibleState.None);
    this.resourceUri = uri;
    this.description = path.relative(projectPath, uri.fsPath);
    this.tooltip = uri.fsPath;
    this.contextValue = FILE_CONTEXT_VALUE;
    this.command = {
      command: "cursorSync.openImportedTranscript",
      title: "Open Imported Transcript",
      arguments: [this],
    };
  }
}

function humanLabel(input: string): string {
  // Typical project folders may end with a hash suffix like -abcdef12 or -<40hexes>
  // If the last dash-separated segment is a short (8) or long (40) hex hash, drop it
  const parts = input.split("-");
  if (parts.length > 1) {
    const last = parts[parts.length - 1];
    const is8 = last.length === 8 && /^[0-9a-fA-F]+$/.test(last);
    const is40 = last.length === 40 && /^[0-9a-fA-F]+$/.test(last);
    if (is8 || is40) {
      parts.pop();
      return parts.join("-");
    }
  }
  return input;
}

export class TranscriptBrowserProvider
  implements
    vscode.TreeDataProvider<TranscriptProjectItem | TranscriptFileItem>
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    TranscriptProjectItem | TranscriptFileItem | undefined | null | void
  >();

  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(
    element: TranscriptProjectItem | TranscriptFileItem
  ): vscode.TreeItem {
    return element;
  }

  async getChildren(
    element?: TranscriptProjectItem | TranscriptFileItem
  ): Promise<Array<TranscriptProjectItem | TranscriptFileItem>> {
    if (element instanceof TranscriptFileItem) {
      return [];
    }

    // Root: list all project folders under ~/.cursor/projects/ that contain agent-transcripts/
    const projectsRoot = path.join(os.homedir(), ".cursor", "projects");
    let projectDirs: string[] = [];
    try {
      const entries = await fs.readdir(projectsRoot, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) {
          const candidate = path.join(projectsRoot, e.name);
          try {
            const transcriptsDir = path.join(candidate, "agent-transcripts");
            const st = await fs.stat(transcriptsDir);
            if (st.isDirectory()) {
              projectDirs.push(e.name);
            }
          } catch {
            // Ignore if the transcripts dir doesn't exist
          }
        }
      }
    } catch {
      // If the projects root doesn't exist yet, return empty list gracefully
      return [];
    }

    // Sort by human label for a stable, intuitive order
    projectDirs.sort((a, b) => humanLabel(a).localeCompare(humanLabel(b)));

    if (!element) {
      // Root level: return project items
      return projectDirs.map((name) => new TranscriptProjectItem(name, path.join(projectsRoot, name)));
    }

    // If an actual project item is provided, list transcript files within it
    return this.getTranscriptFilesForFolder(element.projectPath);
  }
  
  private async getTranscriptFilesForFolder(projectPath: string): Promise<TranscriptFileItem[]> {
    const transcriptsRoot = path.join(projectPath, "agent-transcripts");
    let files: string[] = [];
    try {
      async function walk(dir: string): Promise<string[]> {
        let acc: string[] = [];
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const en of entries) {
          const full = path.join(dir, en.name);
          if (en.isDirectory()) {
            acc = acc.concat(await walk(full));
          } else if (en.isFile() && full.endsWith(".jsonl")) {
            acc.push(full);
          }
        }
        return acc;
      }
      // If transcriptsRoot doesn't exist, return empty
      files = await walk(transcriptsRoot);
    } catch {
      // Gracefully handle missing transcripts dir
      return [];
    }

    files.sort((a, b) => a.localeCompare(b));
    return files.map((file) => new TranscriptFileItem(vscode.Uri.file(file), projectPath));
  }
}

export function initializeTranscriptBrowser(
  context: vscode.ExtensionContext
): void {
  const provider = new TranscriptBrowserProvider();
  const view = vscode.window.createTreeView(VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: true,
  });

  context.subscriptions.push(
    view,
    vscode.commands.registerCommand(
      "cursorSync.refreshImportedTranscripts",
      () => provider.refresh()
    ),
    vscode.commands.registerCommand(
      "cursorSync.openImportedTranscript",
      async (item?: TranscriptFileItem) => {
        if (!item) {
          return;
        }
        const document = await vscode.workspace.openTextDocument(item.uri);
        await vscode.window.showTextDocument(document, { preview: false });
      }
    ),
    vscode.commands.registerCommand(
      "cursorSync.revealImportedTranscriptInExplorer",
      async (item?: TranscriptFileItem) => {
        if (!item) {
          return;
        }
        await vscode.commands.executeCommand("revealInExplorer", item.uri);
      }
    )
  );
}
