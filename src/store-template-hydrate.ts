import * as fs from "node:fs/promises";
import * as path from "node:path";
import { escapeSqlLiteral } from "./composer-merge.js";
import type { ChatsManifestChat } from "./chats-manifest.js";
import { getChatTimestampMs } from "./chats-manifest.js";
import { __chatPersistenceInternals } from "./transcripts.js";

const { runSqliteScript, querySqliteRows } = __chatPersistenceInternals;

export const GOLDEN_STORE_TEMPLATE_VERSION = 1;

/** Documented when the bundled template was last regenerated (manual). */
export const GOLDEN_TEMPLATE_CAPTURED_FOR_CURSOR = "regenerate via resources/golden-store-template.sql";

export async function readTemplateUserVersion(dbPath: string): Promise<number | undefined> {
  try {
    const rows = await querySqliteRows(dbPath, "PRAGMA user_version;");
    const v = rows[0]?.user_version;
    if (typeof v === "number") {
      return v;
    }
    if (typeof v === "string") {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export async function assertTemplateLayout(dbPath: string): Promise<void> {
  const ver = await readTemplateUserVersion(dbPath);
  if (ver !== GOLDEN_STORE_TEMPLATE_VERSION) {
    throw new Error(
      `Golden store template user_version mismatch: expected ${GOLDEN_STORE_TEMPLATE_VERSION}, got ${String(ver)}. Regenerate resources/golden-chat-store.template.db.`
    );
  }
  const meta = await querySqliteRows(dbPath, "SELECT key FROM meta WHERE key = '0' LIMIT 1;");
  const blobs = await querySqliteRows(dbPath, "SELECT id FROM blobs WHERE id = 'root' LIMIT 1;");
  if (meta.length === 0 || blobs.length === 0) {
    throw new Error(
      "Golden store template missing expected meta/blobs rows. Regenerate resources/golden-chat-store.template.db."
    );
  }
}

function buildCursorMessageParts(chat: ChatsManifestChat): string {
  const parts = chat.content.map((m) => {
    const role = m.role === "assistant" ? "assistant" : m.role === "tool" ? "tool" : "user";
    return JSON.stringify({
      role,
      content: [{ type: "text", text: m.content }],
    });
  });
  return `[${parts.join(",")}]`;
}

export async function hydrateGoldenStoreTemplate(options: {
  templatePath: string;
  outputPath: string;
  chat: ChatsManifestChat;
}): Promise<{ warnings: string[] }> {
  const warnings: string[] = [];
  await assertTemplateLayout(options.templatePath);
  await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
  await fs.copyFile(options.templatePath, options.outputPath);

  const metaObj = {
    agentId: options.chat.chat_id,
    latestRootBlobId: "root",
    name: options.chat.title,
    mode: "default",
    createdAt: getChatTimestampMs(options.chat),
  };
  const metaJson = JSON.stringify(metaObj);
  const blobJson = buildCursorMessageParts(options.chat);

  const script =
    `BEGIN IMMEDIATE;\n` +
    `UPDATE meta SET value = CAST('${escapeSqlLiteral(metaJson)}' AS BLOB) WHERE key = '0';\n` +
    `UPDATE blobs SET value = CAST('${escapeSqlLiteral(blobJson)}' AS BLOB) WHERE id = 'root';\n` +
    `COMMIT;\n`;

  await runSqliteScript(options.outputPath, script);
  warnings.push(
    "Golden template hydration is best-effort; Cursor upgrades may change store.db layout. See docs/transcript-fidelity-matrix.md."
  );
  return { warnings };
}
