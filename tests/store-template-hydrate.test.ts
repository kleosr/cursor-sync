import { describe, it, expect, beforeAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const templatePath = path.join(repoRoot, "resources", "golden-chat-store.template.db");

describe("store-template-hydrate", () => {
  let canRun: boolean;

  beforeAll(async () => {
    try {
      await fs.access(templatePath);
      canRun = true;
    } catch {
      canRun = false;
    }
  });

  it("hydrates template with chat messages", async () => {
    if (!canRun) {
      return;
    }
    const { hydrateGoldenStoreTemplate, readTemplateUserVersion } = await import(
      "../src/store-template-hydrate.js"
    );
    const { __chatPersistenceInternals } = await import("../src/transcripts.js");
    const { querySqliteRows } = __chatPersistenceInternals;

    const outDir = path.join(os.tmpdir(), `cursor-sync-hydrate-${Date.now()}`);
    const outPath = path.join(outDir, "store.db");
    await fs.mkdir(outDir, { recursive: true });

    const chatId = "b9283093-88f1-47e6-b140-3aad0db9138d";
    await hydrateGoldenStoreTemplate({
      templatePath,
      outputPath: outPath,
      chat: {
        chat_id: chatId,
        title: "Test title",
        content: [
          { role: "user", content: "one" },
          { role: "assistant", content: "two" },
        ],
        timestamp: 1712345678000,
      },
    });

    const ver = await readTemplateUserVersion(outPath);
    expect(ver).toBe(1);

    const metaRows = await querySqliteRows(
      outPath,
      "SELECT CAST(value AS TEXT) AS v FROM meta WHERE key = '0' LIMIT 1;"
    );
    const metaText = String(metaRows[0]?.v ?? "");
    expect(metaText).toContain(chatId);
    expect(metaText).toContain("Test title");

    const blobRows = await querySqliteRows(
      outPath,
      "SELECT CAST(value AS TEXT) AS v FROM blobs WHERE id = 'root' LIMIT 1;"
    );
    const blobText = String(blobRows[0]?.v ?? "");
    expect(blobText).toContain("one");
    expect(blobText).toContain("two");

    await fs.rm(outDir, { recursive: true, force: true });
  });
});
