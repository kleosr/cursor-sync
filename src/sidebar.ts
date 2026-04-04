import * as vscode from "vscode";
import { loadSyncState, loadSyncHistory } from "./diagnostics.js";
import type { SyncHistoryEntry } from "./types.js";

let sidebarProviderInstance: SidebarProvider | undefined;

export function initializeSidebar(context: vscode.ExtensionContext): SidebarProvider {
  sidebarProviderInstance = new SidebarProvider(context);
  return sidebarProviderInstance;
}

export function refreshSidebar(): void {
  sidebarProviderInstance?.refresh();
}

interface SidebarState {
  status: "synced" | "not-synced" | "syncing" | "error";
  lastSyncTime: string | undefined;
  lastSyncDirection: "push" | "pull" | undefined;
  fileCount: number;
  gistId: string | undefined;
  history: SyncHistoryEntry[];
}

export class SidebarProvider implements vscode.WebviewViewProvider {
  private _view: vscode.WebviewView | undefined;

  constructor(private context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.onDidReceiveMessage((message: { command: string }) => {
      switch (message.command) {
        case "syncNow":
          vscode.commands.executeCommand("cursorSync.syncNow");
          break;
        case "push":
          vscode.commands.executeCommand("cursorSync.push");
          break;
        case "pull":
          vscode.commands.executeCommand("cursorSync.pull");
          break;
        case "export":
          vscode.commands.executeCommand("cursorSync.export");
          break;
        case "import":
          vscode.commands.executeCommand("cursorSync.import");
          break;
        case "configure":
          vscode.commands.executeCommand("cursorSync.configureGithub");
          break;
      }
    });

    this._updateView();
  }

  refresh(): void {
    this._updateView();
  }

  private async _updateView(): Promise<void> {
    if (!this._view) {
      return;
    }
    const state = await this._getState();
    this._view.webview.html = getWebviewHtml(state);
  }

  private async _getState(): Promise<SidebarState> {
    const syncState = await loadSyncState(this.context);
    const history = await loadSyncHistory(this.context);

    if (!syncState) {
      return {
        status: "not-synced",
        lastSyncTime: undefined,
        lastSyncDirection: undefined,
        fileCount: 0,
        gistId: undefined,
        history,
      };
    }

    return {
      status: "synced",
      lastSyncTime: syncState.lastSyncTimestamp,
      lastSyncDirection: syncState.lastSyncDirection,
      fileCount: Object.keys(syncState.localChecksums).length,
      gistId: syncState.gistId,
      history,
    };
  }
}

function relativeTime(isoString: string): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;

  if (diffMs < 0) {
    return "just now";
  }

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) {
    return "just now";
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `${days}d ago`;
  }

  return new Date(isoString).toLocaleDateString();
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderHistoryEntry(entry: SyncHistoryEntry): string {
  const icon = entry.direction === "push" ? "arrow-up" : "arrow-down";
  const dirLabel = entry.direction === "push" ? "Push" : "Pull";
  const triggerBadge = entry.trigger === "scheduled" ? `<span class="badge badge-auto">auto</span>` : "";
  const statusClass = entry.success ? "success" : "failure";
  const statusDot = `<span class="status-dot ${statusClass}"></span>`;
  const time = relativeTime(entry.timestamp);
  const detail = entry.success
    ? `${entry.fileCount} file${entry.fileCount !== 1 ? "s" : ""}`
    : escapeHtml(entry.error ?? "Failed");

  return `<div class="history-entry">
    <div class="history-entry-left">
      ${statusDot}
      <span class="codicon codicon-${icon}"></span>
      <span class="history-dir">${dirLabel}</span>
      ${triggerBadge}
    </div>
    <div class="history-entry-right">
      <span class="history-detail">${detail}</span>
      <span class="history-time">${time}</span>
    </div>
  </div>`;
}

function getWebviewHtml(state: SidebarState): string {
  const statusIconMap = {
    synced: "check",
    "not-synced": "warning",
    syncing: "sync~spin",
    error: "error",
  };
  const statusLabelMap = {
    synced: "Synced",
    "not-synced": "Not Synced",
    syncing: "Syncing...",
    error: "Sync Error",
  };

  const statusIcon = statusIconMap[state.status];
  const statusLabel = statusLabelMap[state.status];
  const lastSyncText = state.lastSyncTime ? relativeTime(state.lastSyncTime) : "Never";
  const directionIcon = state.lastSyncDirection === "push" ? "arrow-up" : state.lastSyncDirection === "pull" ? "arrow-down" : "";
  const directionLabel = state.lastSyncDirection === "push" ? "Push" : state.lastSyncDirection === "pull" ? "Pull" : "";

  const cursorLogoSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 746.78 746.78">
    <rect fill="transparent" width="746.78" height="746.78"/>
    <g>
      <path class="st0" d="M373.39,373.39l239.25,138.13c-1.47,2.55-3.6,4.72-6.24,6.24l-223.63,129.11c-5.81,3.35-12.97,3.35-18.78,0l-223.63-129.11c-2.64-1.52-4.77-3.7-6.24-6.24l239.25-138.13h.02Z"/>
      <path class="st1" d="M373.39,97.39v276l-239.25,138.13c-1.47-2.55-2.29-5.49-2.29-8.53V243.79c0-6.1,3.25-11.72,8.53-14.77l223.62-129.11c2.91-1.68,6.15-2.52,9.39-2.52h.01s-.01,0-.01,0Z"/>
      <path class="st3" d="M612.64,235.26c-1.47-2.55-3.6-4.72-6.24-6.24l-223.63-129.11c-2.9-1.68-6.14-2.52-9.38-2.52v276l239.25,138.13c1.47-2.55,2.29-5.49,2.29-8.53V243.79c0-3.05-.81-5.97-2.29-8.53h-.01.01Z"/>
      <path class="st4" d="M595.9,244.93c1.36,2.34,1.54,5.34,0,8.01l-217.18,376.15c-1.46,2.55-5.34,1.5-5.34-1.43v-247.87c0-1.98-.53-3.88-1.49-5.55l224-129.33h.01v.02Z"/>
      <path class="st2" d="M595.9,244.93l-224,129.33c-.95-1.66-2.34-3.06-4.06-4.06l-214.65-123.93c-2.55-1.46-1.5-5.34,1.43-5.34h434.34c3.08,0,5.59,1.67,6.93,4.01h.01Z"/>
    </g>
  </svg>`;

  const historyHtml = state.history.length > 0
    ? state.history.map(renderHistoryEntry).join("")
    : `<div class="empty-state">No sync history yet</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif);
      font-size: 13px;
      color: #edecec;
      background: #14120b;
      padding: 14px;
      line-height: 1.5;
      min-height: 100vh;
    }

    /* ── Status Card ── */
    .status-card {
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      gap: 14px;
      border: 1px solid rgba(237, 236, 236, 0.06);
      background: #1c1a13;
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
    }
    .status-card:hover {
      border-color: rgba(237, 236, 236, 0.12);
    }
    .status-card.synced {
      background: linear-gradient(135deg, rgba(52, 211, 153, 0.06) 0%, #1c1a13 100%);
      border-color: rgba(52, 211, 153, 0.15);
    }
    .status-card.synced:hover {
      border-color: rgba(52, 211, 153, 0.25);
      box-shadow: 0 0 20px rgba(52, 211, 153, 0.08);
    }
    .status-card.not-synced {
      background: linear-gradient(135deg, rgba(245, 158, 11, 0.06) 0%, #1c1a13 100%);
      border-color: rgba(245, 158, 11, 0.15);
    }
    .status-card.not-synced:hover {
      border-color: rgba(245, 158, 11, 0.25);
      box-shadow: 0 0 20px rgba(245, 158, 11, 0.08);
    }
    .status-card.syncing {
      background: linear-gradient(135deg, rgba(125, 211, 252, 0.06) 0%, #1c1a13 100%);
      border-color: rgba(125, 211, 252, 0.15);
    }
    .status-card.syncing:hover {
      border-color: rgba(125, 211, 252, 0.25);
      box-shadow: 0 0 20px rgba(125, 211, 252, 0.08);
    }
    .status-card.error {
      background: linear-gradient(135deg, rgba(248, 113, 113, 0.06) 0%, #1c1a13 100%);
      border-color: rgba(248, 113, 113, 0.15);
    }
    .status-card.error:hover {
      border-color: rgba(248, 113, 113, 0.25);
      box-shadow: 0 0 20px rgba(248, 113, 113, 0.08);
    }

    .status-icon-wrapper {
      width: 40px;
      height: 40px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      font-size: 18px;
      transition: box-shadow 0.2s ease;
      overflow: hidden;
    }
    .status-icon-wrapper svg {
      width: 28px;
      height: 28px;
    }
    .synced .status-icon-wrapper {
      background: rgba(52, 211, 153, 0.12);
      box-shadow: 0 0 12px rgba(52, 211, 153, 0.15);
    }
    .synced .status-icon-wrapper svg .st0 { fill: #34d399; }
    .synced .status-icon-wrapper svg .st1 { fill: #2cb885; }
    .synced .status-icon-wrapper svg .st3 { fill: #239b6f; }
    .synced .status-icon-wrapper svg .st4 { fill: #6ee7b7; }
    .synced .status-icon-wrapper svg .st2 { fill: transparent; }
    .not-synced .status-icon-wrapper {
      background: rgba(245, 158, 11, 0.12);
      color: #f59e0b;
      box-shadow: 0 0 12px rgba(245, 158, 11, 0.15);
    }
    .syncing .status-icon-wrapper {
      background: rgba(125, 211, 252, 0.12);
      color: #7dd3fc;
      box-shadow: 0 0 12px rgba(125, 211, 252, 0.15);
    }
    .error .status-icon-wrapper {
      background: rgba(248, 113, 113, 0.12);
      color: #f87171;
      box-shadow: 0 0 12px rgba(248, 113, 113, 0.15);
    }

    .status-info { flex: 1; min-width: 0; }
    .status-label {
      font-weight: 600;
      font-size: 14px;
      display: block;
      margin-bottom: 3px;
      letter-spacing: -0.01em;
    }
    .status-meta {
      font-size: 11px;
      color: rgba(237, 236, 236, 0.32);
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .status-meta .codicon { font-size: 11px; color: rgba(237, 236, 236, 0.22); }

    .file-count {
      font-size: 11px;
      color: rgba(237, 236, 236, 0.22);
      margin-top: 3px;
    }

    /* ── Sync Now Button ── */
    .sync-now-btn {
      width: 100%;
      padding: 10px 16px;
      border: none;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      background: #ededec;
      color: #0c0c0a;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      letter-spacing: -0.01em;
      transition: transform 0.15s ease, box-shadow 0.15s ease, filter 0.15s ease;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    }
    .sync-now-btn:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(237, 236, 236, 0.1);
      background: rgba(237, 236, 236, 0.88);
    }
    .sync-now-btn:active {
      transform: translateY(0);
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
      filter: brightness(0.95);
    }

    /* ── Section Headers ── */
    .section { margin-bottom: 16px; }
    .section-header {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1.2px;
      color: rgba(237, 236, 236, 0.32);
      margin-bottom: 8px;
      padding: 0 2px;
    }

    /* ── Action Grid ── */
    .action-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    .action-btn {
      padding: 9px 12px;
      border: 1px solid rgba(237, 236, 236, 0.06);
      border-radius: 8px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      background: #1c1a13;
      color: rgba(237, 236, 236, 0.55);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: all 0.15s ease;
    }
    .action-btn:hover {
      background: #22201a;
      border-color: rgba(237, 236, 236, 0.12);
      color: #edecec;
    }
    .action-btn:active {
      background: #1a1812;
      transform: scale(0.98);
    }
    .action-btn .codicon {
      color: #34d399;
      font-size: 13px;
      transition: color 0.15s ease;
    }
    .action-btn:hover .codicon {
      color: #6ee7b7;
    }

    /* ── History List ── */
    .history-list { display: flex; flex-direction: column; gap: 2px; }
    .history-entry {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 10px;
      border-radius: 6px;
      font-size: 12px;
      gap: 8px;
      background: #0f0e0c;
      border: 1px solid transparent;
      transition: all 0.15s ease;
    }
    .history-entry:hover {
      background: #22201a;
      border-color: rgba(237, 236, 236, 0.06);
    }
    .history-entry-left {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }
    .history-entry-right {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      flex-shrink: 1;
    }
    .history-dir { font-weight: 500; color: rgba(237, 236, 236, 0.55); }
    .history-detail { color: rgba(237, 236, 236, 0.32); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .history-time { color: rgba(237, 236, 236, 0.22); font-size: 11px; white-space: nowrap; }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .status-dot.success {
      background: #34d399;
      box-shadow: 0 0 6px rgba(52, 211, 153, 0.4);
    }
    .status-dot.failure {
      background: #f87171;
      box-shadow: 0 0 6px rgba(248, 113, 113, 0.4);
    }

    .badge {
      font-size: 9px;
      padding: 1px 6px;
      border-radius: 4px;
      font-weight: 600;
      letter-spacing: 0.3px;
    }
    .badge-auto {
      background: rgba(237, 236, 236, 0.05);
      color: rgba(237, 236, 236, 0.32);
      border: 1px solid rgba(237, 236, 236, 0.12);
    }

    .empty-state {
      text-align: center;
      padding: 20px 8px;
      color: rgba(237, 236, 236, 0.22);
      font-size: 12px;
      font-style: italic;
    }

    /* ── Configure GitHub Button ── */
    .configure-btn {
      width: 100%;
      padding: 9px 12px;
      border: 1px dashed rgba(237, 236, 236, 0.08);
      border-radius: 8px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      background: transparent;
      color: rgba(237, 236, 236, 0.32);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: all 0.15s ease;
    }
    .configure-btn:hover {
      border-color: rgba(52, 211, 153, 0.3);
      color: #34d399;
      background: rgba(52, 211, 153, 0.04);
    }
    .configure-btn .codicon { font-size: 13px; }

    .codicon {
      font-family: 'codicon';
      font-size: 14px;
    }

    /* ── Scrollbar ── */
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: #161614; }
    ::-webkit-scrollbar-thumb { background: #2a2a28; border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: #3a3a37; }
  </style>
</head>
<body>
  <div class="status-card ${state.status}">
    <div class="status-icon-wrapper">
      ${state.status === 'synced' ? cursorLogoSvg : `<span class="codicon codicon-${statusIcon}"></span>`}
    </div>
    <div class="status-info">
      <span class="status-label">${statusLabel}</span>
      <div class="status-meta">
        <span>${lastSyncText}</span>
        ${directionLabel ? `<span class="codicon codicon-${directionIcon}"></span><span>${directionLabel}</span>` : ""}
      </div>
      ${state.fileCount > 0 ? `<div class="file-count">${state.fileCount} file${state.fileCount !== 1 ? "s" : ""} tracked</div>` : ""}
    </div>
  </div>

  <button class="sync-now-btn" onclick="post('syncNow')">
    <span class="codicon codicon-sync"></span>
    Sync Now
  </button>

  <div class="section">
    <div class="section-header">Actions</div>
    <div class="action-grid">
      <button class="action-btn" onclick="post('push')"><span class="codicon codicon-cloud-upload"></span> Push</button>
      <button class="action-btn" onclick="post('pull')"><span class="codicon codicon-cloud-download"></span> Pull</button>
      <button class="action-btn" onclick="post('export')"><span class="codicon codicon-export"></span> Export</button>
      <button class="action-btn" onclick="post('import')"><span class="codicon codicon-desktop-download"></span> Import</button>
    </div>
  </div>

  <div class="section">
    <div class="section-header">History</div>
    <div class="history-list">
      ${historyHtml}
    </div>
  </div>

  <div class="section">
    <button class="configure-btn" onclick="post('configure')">
      <span class="codicon codicon-github-alt"></span> Configure GitHub
    </button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    function post(command) { vscode.postMessage({ command }); }
  </script>
</body>
</html>`;
}
