import * as vscode from "vscode";
import { configureGithub, getToken } from "./auth.js";
import { executePush } from "./push.js";
import { executePull } from "./pull.js";
import { executeExport } from "./export.js";
import { executeImport } from "./import.js";
import { executeExportTranscripts, executeImportTranscripts } from "./transcripts.js";
import { executeSaveChatLocal, executeLoadChatLocal } from "./chat-persistence.js";
import { executeImportTranscriptsFromGist } from "./import-gist-transcripts.js";
import { showStatus } from "./diagnostics.js";
import { resolveConflictsCommand } from "./conflicts.js";
import { executeReset } from "./reset.js";
import { startScheduler, stopScheduler } from "./scheduler.js";
import { determineSyncAction } from "./scheduler.js";
import { getLogger, loadSyncState } from "./diagnostics.js";
import { initializeSidebar } from "./sidebar.js";
import { initializeStatusBar, updateStatusBar } from "./statusbar.js";
import { getOrCreateClientId } from "./analytics.js";
import { initializeTranscriptBrowser } from "./transcript-browser.js";
import {
  executeFinalizeStateReconciliation,
  executePrepareStateReconciliation,
  notifyPendingStateBundleIfAny,
} from "./state-reconciliation.js";
import { executePrepareSyncFromLandingZone } from "./sync-engine.js";

let configListener: vscode.Disposable | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const logger = getLogger();

  initializeStatusBar(context);
  initializeTranscriptBrowser(context);

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.configureGithub", () =>
      configureGithub(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.push", () =>
      executePush(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.pull", () =>
      executePull(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.showStatus", () =>
      showStatus(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.resolveConflicts", () =>
      resolveConflictsCommand(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.reset", () =>
      executeReset(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.export", () =>
      executeExport(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.import", () =>
      executeImport(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.exportTranscripts", () =>
      executeExportTranscripts(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.importTranscripts", () =>
      executeImportTranscripts(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.saveChatLocal", () =>
      executeSaveChatLocal(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.loadChatLocal", () =>
      executeLoadChatLocal(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.importTranscriptsFromGist", () =>
      executeImportTranscriptsFromGist(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.syncNow", () =>
      executeSyncNow(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.prepareStateReconciliation", () =>
      executePrepareStateReconciliation(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.finalizeStateReconciliation", () =>
      executeFinalizeStateReconciliation(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.prepareSyncFromLandingZone", () =>
      executePrepareSyncFromLandingZone(context)
    )
  );

  const sidebarProvider = initializeSidebar(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("cursorSync.sidebar", sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  updateConfiguredContext(context);
  getOrCreateClientId(context);
  startScheduler(context);

  configListener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("cursorSync.schedule")) {
      stopScheduler();
      startScheduler(context);
    }
  });
  context.subscriptions.push(configListener);

  void notifyPendingStateBundleIfAny(context);

  logger.appendLine(`[${new Date().toISOString()}] Cursor Sync activated`);
}

export function deactivate(): void {
  stopScheduler();
}

async function executeSyncNow(context: vscode.ExtensionContext): Promise<void> {
  const logger = getLogger();
  logger.appendLine(`[${new Date().toISOString()}] Sync Now triggered`);

  try {
    const result = await determineSyncAction(context);
    switch (result.action) {
      case "none":
        vscode.window.showInformationMessage("Already in sync, nothing to do.");
        break;
      case "pull":
        await executePull(context);
        break;
      case "push":
        await executePush(context);
        break;
      case "pull-push": {
        const pullOk = await executePull(context);
        if (pullOk) {
          await executePush(context);
        }
        break;
      }
      case "conflict":
        vscode.window.showWarningMessage(
          `${result.keys.length} conflict(s) detected. Resolve them first.`
        );
        vscode.commands.executeCommand("cursorSync.resolveConflicts");
        break;
      case "error":
        vscode.window.showErrorMessage(`Sync failed: ${result.reason}`);
        break;
    }
  } catch (err) {
    logger.appendLine(
      `[${new Date().toISOString()}] Sync Now failed: ${err instanceof Error ? err.message : String(err)}`
    );
    vscode.window.showErrorMessage(
      `Sync failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function updateConfiguredContext(
  context: vscode.ExtensionContext
): Promise<void> {
  const token = await getToken(context);
  const isConfigured = token !== undefined;
  
  await vscode.commands.executeCommand(
    "setContext",
    "cursorSync.configured",
    isConfigured
  );

  if (isConfigured) {
    const syncState = await loadSyncState(context);
    const lastSync = syncState ? new Date(syncState.lastSyncTimestamp) : undefined;
    updateStatusBar("ok", lastSync);
  } else {
    updateStatusBar("unconfigured");
  }
}
