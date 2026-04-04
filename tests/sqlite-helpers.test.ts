import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import { __transcriptsTestUtils } from "../src/transcripts.js";

const { isCommandMissingError, querySqliteRowsImpl } = __transcriptsTestUtils;

describe("isCommandMissingError", () => {
  it("detects POSIX spawn ENOENT", () => {
    expect(isCommandMissingError(new Error("spawn sqlite3 ENOENT"), "sqlite3")).toBe(true);
    expect(isCommandMissingError(new Error("spawn python3 ENOENT"), "python3")).toBe(true);
  });

  it("detects Windows-style not recognized messages", () => {
    expect(
      isCommandMissingError(
        new Error("'python3' is not recognized as an internal or external command"),
        "python3"
      )
    ).toBe(true);
    expect(
      isCommandMissingError(new Error("'sqlite3' is not recognized as an internal or external command"), "sqlite3")
    ).toBe(true);
  });

  it("detects exit code 9009 hint", () => {
    expect(isCommandMissingError(new Error("Command failed with exit code 9009"), "sqlite3")).toBe(true);
  });

  it("returns false for unrelated failures", () => {
    expect(isCommandMissingError(new Error("SQLITE_BUSY: database is locked"), "sqlite3")).toBe(false);
    expect(isCommandMissingError(new Error("syntax error near foo"), "sqlite3")).toBe(false);
  });
});

describe("querySqliteRowsImpl", () => {
  it("returns parsed rows on success", async () => {
    const runQuery = vi.fn().mockResolvedValue({ stdout: '[{"key":"k","value":"v"}]', stderr: "" });
    const rows = await querySqliteRowsImpl(runQuery, "/tmp/x.db", "SELECT 1", { retries: 1 });
    expect(rows).toEqual([{ key: "k", value: "v" }]);
    expect(runQuery).toHaveBeenCalledTimes(1);
  });

  it("returns empty array when stdout is empty", async () => {
    const runQuery = vi.fn().mockResolvedValue({ stdout: "   \n", stderr: "" });
    const rows = await querySqliteRowsImpl(runQuery, "/tmp/x.db", "SELECT 1", { retries: 1 });
    expect(rows).toEqual([]);
  });

  it("propagates non-timeout errors immediately", async () => {
    const err = new Error("spawn python3 ENOENT");
    const runQuery = vi.fn().mockRejectedValue(err);
    await expect(querySqliteRowsImpl(runQuery, "/tmp/x.db", "SELECT 1", { retries: 3 })).rejects.toThrow(
      "spawn python3 ENOENT"
    );
    expect(runQuery).toHaveBeenCalledTimes(1);
  });

  it("retries on timeout then succeeds", async () => {
    vi.useFakeTimers();
    const timeoutErr = Object.assign(new Error("Command timed out"), {
      killed: true,
      code: "ETIMEDOUT",
    });
    const runQuery = vi
      .fn()
      .mockRejectedValueOnce(timeoutErr)
      .mockResolvedValue({ stdout: "[]", stderr: "" });

    const rowsPromise = querySqliteRowsImpl(runQuery, "/tmp/x.db", "SELECT 1", { retries: 2 });
    await vi.runAllTimersAsync();
    const rows = await rowsPromise;

    expect(rows).toEqual([]);
    expect(runQuery).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
