import { describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import {
  computeArtifactChecksum,
  encodeTranscriptArtifact,
  decodeTranscriptArtifact,
} from "../src/transcript-bundle.js";

import type { ChatBundle } from "../src/chat-persistence.js";

describe("chat-persistence bundle format", () => {
  it("produces a valid ChatBundle structure", () => {
    const transcriptContent = Buffer.from(
      '{"role":"user","content":"hello"}\n{"role":"assistant","content":"hi"}\n'
    );
    const encoded = encodeTranscriptArtifact(transcriptContent);
    const checksum = computeArtifactChecksum(transcriptContent);

    const bundle: ChatBundle = {
      schemaVersion: 1,
      type: "chat-persistence",
      createdAt: new Date().toISOString(),
      conversationId: "test-conv-001",
      title: "hello",
      subtitle: "1 file",
      previewText: "hello",
      sidebarSnapshot: null,
      storeSnapshot: null,
      transcriptFiles: [
        {
          relativePath: "proj/agent-transcripts/test-conv-001/main.jsonl",
          content: encoded.content,
          encoding: encoded.encoding,
          checksum,
          sizeBytes: transcriptContent.length,
        },
      ],
    };

    expect(bundle.type).toBe("chat-persistence");
    expect(bundle.schemaVersion).toBe(1);
    expect(bundle.transcriptFiles).toHaveLength(1);
    expect(bundle.transcriptFiles[0]!.checksum).toBe(checksum);
  });

  it("round-trips transcript content through encode/decode", () => {
    const original = Buffer.from('{"role":"user","content":"test"}\n');
    const encoded = encodeTranscriptArtifact(original);
    const decoded = decodeTranscriptArtifact(encoded.content, encoded.encoding);

    expect(decoded.equals(original)).toBe(true);
  });

  it("round-trips store.db binary through base64", () => {
    // Simulate a small SQLite header
    const fakeSqliteHeader = Buffer.alloc(100);
    fakeSqliteHeader.write("SQLite format 3\0", 0, "ascii");
    crypto.randomFillSync(fakeSqliteHeader, 16);

    const encoded = encodeTranscriptArtifact(fakeSqliteHeader, true);
    expect(encoded.encoding).toBe("base64");

    const decoded = decodeTranscriptArtifact(encoded.content, encoded.encoding);
    expect(decoded.equals(fakeSqliteHeader)).toBe(true);

    const checksum = computeArtifactChecksum(fakeSqliteHeader);
    const verifyChecksum = computeArtifactChecksum(decoded);
    expect(verifyChecksum).toBe(checksum);
  });

  it("validates checksum integrity detection", () => {
    const content = Buffer.from("original content");
    const checksum = computeArtifactChecksum(content);

    const tampered = Buffer.from("tampered content");
    const tamperedChecksum = computeArtifactChecksum(tampered);

    expect(tamperedChecksum).not.toBe(checksum);
  });

  it("serializes and deserializes a full bundle via JSON", () => {
    const storeContent = Buffer.from([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]);
    const bundle: ChatBundle = {
      schemaVersion: 1,
      type: "chat-persistence",
      createdAt: "2026-04-03T00:00:00.000Z",
      conversationId: "conv-abc",
      title: "Test Chat",
      subtitle: "0 files",
      previewText: "Test Chat",
      sidebarSnapshot: {
        conversationId: "conv-abc",
        composerHeaders: { allComposers: [{ composerId: "conv-abc", name: "Test Chat" }] },
      },
      storeSnapshot: {
        content: storeContent.toString("base64"),
        encoding: "base64",
        checksum: computeArtifactChecksum(storeContent),
        sizeBytes: storeContent.length,
        sourceWorkspaceKey: "ws-123",
      },
      transcriptFiles: [],
    };

    const serialized = JSON.stringify(bundle);
    const deserialized = JSON.parse(serialized) as ChatBundle;

    expect(deserialized.type).toBe("chat-persistence");
    expect(deserialized.storeSnapshot?.checksum).toBe(bundle.storeSnapshot?.checksum);
    expect(deserialized.sidebarSnapshot?.conversationId).toBe("conv-abc");

    // Verify store round-trip
    const decodedStore = decodeTranscriptArtifact(
      deserialized.storeSnapshot!.content,
      deserialized.storeSnapshot!.encoding
    );
    expect(decodedStore.equals(storeContent)).toBe(true);
  });
});
