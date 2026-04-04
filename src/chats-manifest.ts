import type { ComposerHeadersPayload } from "./types/composer-state.js";

export const CHATS_MANIFEST_SCHEMA_VERSION = 1 as const;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type StateReconciliationTarget = "global" | "workspace";

export interface ChatMessageEntry {
  role: string;
  content: string;
}

export interface ChatsManifestChat {
  chat_id: string;
  title: string;
  content: ChatMessageEntry[];
  timestamp: number | string;
}

export interface ChatsManifestV1 {
  schemaVersion: typeof CHATS_MANIFEST_SCHEMA_VERSION;
  stateTarget: StateReconciliationTarget;
  /** Required when stateTarget is workspace: folder name under User/workspaceStorage */
  workspaceStorageFolderId?: string;
  /** Target segment under ~/.cursor/chats/<workspaceKey>/ */
  workspaceKey: string;
  chats: ChatsManifestChat[];
}

export interface ParseChatsManifestOk {
  ok: true;
  manifest: ChatsManifestV1;
}

export interface ParseChatsManifestErr {
  ok: false;
  errors: string[];
}

export type ParseChatsManifestResult = ParseChatsManifestOk | ParseChatsManifestErr;

function isUuid(s: string): boolean {
  return UUID_RE.test(s.trim());
}

export function parseChatTimestamp(raw: number | string): { iso: string; unixMs: number } {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const ms = raw < 1e12 ? raw * 1000 : raw;
    return { iso: new Date(ms).toISOString(), unixMs: ms };
  }
  if (typeof raw === "string" && raw.trim().length > 0) {
    const n = Number(raw);
    if (!Number.isNaN(n) && raw.trim().match(/^\d+$/)) {
      const ms = n < 1e12 ? n * 1000 : n;
      return { iso: new Date(ms).toISOString(), unixMs: ms };
    }
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) {
      return { iso: d.toISOString(), unixMs: d.getTime() };
    }
  }
  const now = Date.now();
  return { iso: new Date(now).toISOString(), unixMs: now };
}

export function getChatTimestampMs(chat: ChatsManifestChat): number {
  return parseChatTimestamp(chat.timestamp).unixMs;
}

function isSafeWorkspaceKeySegment(key: string): boolean {
  if (key.length === 0 || key === "." || key === "..") {
    return false;
  }
  if (key.includes("/") || key.includes("\\") || key.includes("\0")) {
    return false;
  }
  return true;
}

export function parseChatsManifestJson(raw: string): ParseChatsManifestResult {
  const errors: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, errors: ["Invalid JSON"] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, errors: ["Root must be an object"] };
  }
  const root = parsed as Record<string, unknown>;
  if (root.schemaVersion !== CHATS_MANIFEST_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${CHATS_MANIFEST_SCHEMA_VERSION}`);
  }
  const stateTarget = root.stateTarget;
  if (stateTarget !== "global" && stateTarget !== "workspace") {
    errors.push('stateTarget must be "global" or "workspace"');
  }
  const workspaceKey = root.workspaceKey;
  if (typeof workspaceKey !== "string" || !isSafeWorkspaceKeySegment(workspaceKey)) {
    errors.push("workspaceKey must be a non-empty safe path segment");
  }
  const wsFolder = root.workspaceStorageFolderId;
  if (stateTarget === "workspace") {
    if (typeof wsFolder !== "string" || !isSafeWorkspaceKeySegment(wsFolder)) {
      errors.push("workspaceStorageFolderId is required for workspace state and must be a safe segment");
    }
  } else if (wsFolder !== undefined && typeof wsFolder !== "string") {
    errors.push("workspaceStorageFolderId must be a string when set");
  }

  const chatsRaw = root.chats;
  if (!Array.isArray(chatsRaw) || chatsRaw.length === 0) {
    errors.push("chats must be a non-empty array");
  }

  const chats: ChatsManifestChat[] = [];
  if (Array.isArray(chatsRaw)) {
    for (let i = 0; i < chatsRaw.length; i++) {
      const c = chatsRaw[i];
      if (!c || typeof c !== "object" || Array.isArray(c)) {
        errors.push(`chats[${i}]: expected object`);
        continue;
      }
      const rec = c as Record<string, unknown>;
      const chatId = rec.chat_id;
      const title = rec.title;
      const content = rec.content;
      const timestamp = rec.timestamp;
      if (typeof chatId !== "string" || !isUuid(chatId)) {
        errors.push(`chats[${i}]: chat_id must be a UUID string`);
      }
      if (typeof title !== "string" || title.trim().length === 0) {
        errors.push(`chats[${i}]: title must be a non-empty string`);
      }
      if (!Array.isArray(content)) {
        errors.push(`chats[${i}]: content must be an array`);
      } else {
        for (let j = 0; j < content.length; j++) {
          const m = content[j];
          if (!m || typeof m !== "object" || Array.isArray(m)) {
            errors.push(`chats[${i}].content[${j}]: expected object`);
            continue;
          }
          const mr = m as Record<string, unknown>;
          if (typeof mr.role !== "string" || mr.role.trim().length === 0) {
            errors.push(`chats[${i}].content[${j}]: role required`);
          }
          if (typeof mr.content !== "string") {
            errors.push(`chats[${i}].content[${j}]: content must be string`);
          }
        }
      }
      if (timestamp === undefined) {
        errors.push(`chats[${i}]: timestamp required`);
      }
      if (
        typeof chatId === "string" &&
        isUuid(chatId) &&
        typeof title === "string" &&
        title.trim().length > 0 &&
        Array.isArray(content) &&
        timestamp !== undefined
      ) {
        const messages: ChatMessageEntry[] = [];
        let messagesOk = true;
        for (const m of content) {
          if (!m || typeof m !== "object" || Array.isArray(m)) {
            messagesOk = false;
            break;
          }
          const mr = m as Record<string, unknown>;
          if (typeof mr.role !== "string" || typeof mr.content !== "string") {
            messagesOk = false;
            break;
          }
          messages.push({ role: mr.role, content: mr.content });
        }
        if (messagesOk) {
          chats.push({
            chat_id: chatId.trim(),
            title: title.trim(),
            content: messages,
            timestamp: timestamp as number | string,
          });
        }
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const manifest: ChatsManifestV1 = {
    schemaVersion: CHATS_MANIFEST_SCHEMA_VERSION,
    stateTarget: stateTarget as StateReconciliationTarget,
    workspaceKey: (workspaceKey as string).trim(),
    workspaceStorageFolderId:
      typeof wsFolder === "string" && wsFolder.length > 0 ? wsFolder.trim() : undefined,
    chats,
  };

  return { ok: true, manifest };
}

export function chatToComposerHeadersPayload(
  chat: ChatsManifestChat
): ComposerHeadersPayload {
  const { iso } = parseChatTimestamp(chat.timestamp);
  return {
    allComposers: [
      {
        composerId: chat.chat_id,
        name: chat.title,
        subtitle: "",
        lastUpdatedAt: iso,
        lastOpenedAt: iso,
        createdAt: iso,
        hasUnreadMessages: false,
        isArchived: false,
        isDraft: false,
      },
    ],
  };
}

export function manifestToHeaderPayloads(manifest: ChatsManifestV1): Record<string, unknown>[] {
  return manifest.chats.map((c) => chatToComposerHeadersPayload(c) as unknown as Record<string, unknown>);
}
