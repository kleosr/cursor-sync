import * as path from "node:path";
import * as vscode from "vscode";

const VIEW_ID = "cursorSync.transcriptBrowser";
const FILE_CONTEXT_VALUE = "cursorSyncTranscriptFile";

class TranscriptWorkspaceItem extends vscode.TreeItem {
  constructor(readonly folder: vscode.WorkspaceFolder) {
    super(folder.name, vscode.TreeItemCollapsibleState.Expanded);
    this.description = folder.uri.fsPath;
    this.contextValue = "cursorSyncTranscriptWorkspace";
    this.iconPath = new vscode.ThemeIcon("root-folder");
  }
}

class TranscriptFileItem extends vscode.TreeItem {
  constructor(readonly uri: vscode.Uri, readonly workspaceFolder: vscode.WorkspaceFolder) {
    super(path.basename(uri.fsPath), vscode.TreeItemCollapsibleState.None);
    this.resourceUri = uri;
    this.description = path.relative(workspaceFolder.uri.fsPath, uri.fsPath);
    this.tooltip = uri.fsPath;
    this.contextValue = FILE_CONTEXT_VALUE;
    this.command = {
      command: "cursorSync.openImportedTranscript",
      title: "Open Imported Transcript",
      arguments: [this],
    };
  }
}

export class TranscriptBrowserProvider
  implements
    vscode.TreeDataProvider<TranscriptWorkspaceItem | TranscriptFileItem>
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    TranscriptWorkspaceItem | TranscriptFileItem | undefined | null | void
  >();

  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(
    element: TranscriptWorkspaceItem | TranscriptFileItem
  ): vscode.TreeItem {
    return element;
  }

  async getChildren(
    element?: TranscriptWorkspaceItem | TranscriptFileItem
  ): Promise<Array<TranscriptWorkspaceItem | TranscriptFileItem>> {
    if (element instanceof TranscriptFileItem) {
      return [];
    }

    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    if (workspaceFolders.length === 0) {
      return [];
    }

    if (element instanceof TranscriptWorkspaceItem) {
      return this.getTranscriptFilesForFolder(element.folder);
    }

    if (workspaceFolders.length === 1) {
      return this.getTranscriptFilesForFolder(workspaceFolders[0]!);
    }

    return workspaceFolders.map((folder) => new TranscriptWorkspaceItem(folder));
  }

  private async getTranscriptFilesForFolder(
    folder: vscode.WorkspaceFolder
  ): Promise<TranscriptFileItem[]> {
    const files = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, "agent-transcripts/**/*.jsonl"),
      undefined
    );
    files.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
    return files.map((file) => new TranscriptFileItem(file, folder));
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
