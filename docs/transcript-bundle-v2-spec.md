# Transcript Bundle v2 Spec

This document defines the Phase 2 bundle format for high-fidelity transcript export/import. It extends the current `schemaVersion: 1` transcript manifest in `src/transcripts.ts` without breaking existing imports.

## Goals

- Keep the existing transcript export/import command surface and `transcript-manifest.json` filename.
- Preserve current JSONL export behavior.
- Add explicit records for sidebar metadata from `state.vscdb`.
- Add explicit records for per-chat `store.db` snapshots.
- Keep the format practical for the current codebase: deterministic keys, per-artifact checksums, and direct import planning without more discovery work.

## Scope

Bundle v2 is responsible for three artifact families:

- Project transcript files from `agent-transcripts`.
- Sidebar metadata snapshots derived from `ItemTable["composer.composerHeaders"]` and optional UI state keys.
- Per-chat `store.db` snapshots from `~/.cursor/chats/<workspace_hash>/<agent_uuid>/store.db`.

Bundle v2 is not responsible for:

- Full `state.vscdb` export.
- Full `cursorDiskKV` export.
- Semantic decoding of opaque binary blob rows.

## Design Rules

1. Keep `type: "agent-transcripts"` and bump only `schemaVersion` from `1` to `2`.
2. Keep `transcript-manifest.json` as the manifest filename so the import entrypoint stays stable.
3. Use canonical artifact keys inside the manifest. Transport filenames for Gist upload can keep using the existing slash-to-`--` mapping.
4. Use the root transcript folder id as the conversation root because that is the observed `composerId` domain in project transcripts.
5. Treat `composerId` and `agentId` as separate identity domains. Store both when known. Never derive one from the other by guesswork.
6. Preserve bytes exactly. If an artifact is not valid UTF-8, store it as base64 and mark the encoding in the manifest.
7. Because each observed `store.db` is already conversation-scoped, Phase 2 should export all rows from its `meta` and `blobs` tables rather than attempting graph-pruning by `latestRootBlobId`.

## Top-Level Manifest

```json
{
  "schemaVersion": 2,
  "type": "agent-transcripts",
  "createdAt": "2026-03-30T12:34:56.000Z",
  "sourceMachineId": "sha256...",
  "sourceOS": "linux",
  "sourceProjects": {
    "home-marcelo-dev-private-cursor-sync": {
      "folderName": "home-marcelo-dev-private-cursor-sync",
      "fileCount": 4,
      "conversationCount": 1
    }
  },
  "conversations": {
    "b9283093-88f1-47e6-b140-3aad0db9138d": {
      "projectKey": "home-marcelo-dev-private-cursor-sync",
      "rootComposerId": "b9283093-88f1-47e6-b140-3aad0db9138d",
      "childComposerIds": [
        "75e6483f-fe2e-48f2-9876-37e3abb7ee96",
        "78c40317-75a0-440f-9c31-5195e8f12b93",
        "a2fb4ea5-a7e7-4f36-bbf0-868f5b57f25e"
      ],
      "storeAgents": [
        {
          "workspaceHash": "d034d08620792dea3a1d4b130cce1575",
          "agentId": "1e7fbc61-823f-4d19-83a1-3ec80592f951",
          "relatedComposerId": null
        }
      ],
      "display": {
        "name": "Transcript import/export enhancement tasks",
        "subtitle": "Read README.md, transcripts.test.ts, types.ts, transcripts.ts, unravel-cursor-chat-sidebar-display.plan.md",
        "createdAt": 1774897817326,
        "lastUpdatedAt": 1774897817326,
        "hasUnreadMessages": false,
        "isArchived": false,
        "isDraft": false,
        "unifiedMode": "agent",
        "forceMode": "edit"
      },
      "artifactKeys": [
        "conversations/b9283093-88f1-47e6-b140-3aad0db9138d/transcripts/b9283093-88f1-47e6-b140-3aad0db9138d/b9283093-88f1-47e6-b140-3aad0db9138d.jsonl",
        "conversations/b9283093-88f1-47e6-b140-3aad0db9138d/sidebar/composer/78c40317-75a0-440f-9c31-5195e8f12b93.json",
        "conversations/b9283093-88f1-47e6-b140-3aad0db9138d/store/d034d08620792dea3a1d4b130cce1575/1e7fbc61-823f-4d19-83a1-3ec80592f951/meta/0.json"
      ],
      "warnings": [
        "No deterministic composerId-to-agentId join was inferred. relatedComposerId is null."
      ]
    }
  },
  "artifacts": {
    "conversations/b9283093-88f1-47e6-b140-3aad0db9138d/transcripts/b9283093-88f1-47e6-b140-3aad0db9138d/b9283093-88f1-47e6-b140-3aad0db9138d.jsonl": {
      "kind": "transcript-jsonl",
      "conversationKey": "b9283093-88f1-47e6-b140-3aad0db9138d",
      "checksum": "sha256...",
      "sizeBytes": 12345,
      "contentType": "application/x-ndjson",
      "required": true,
      "source": {
        "kind": "project-file",
        "projectKey": "home-marcelo-dev-private-cursor-sync",
        "relativePath": "agent-transcripts/b9283093-88f1-47e6-b140-3aad0db9138d/b9283093-88f1-47e6-b140-3aad0db9138d.jsonl"
      },
      "target": {
        "kind": "project-file",
        "relativePath": "agent-transcripts/b9283093-88f1-47e6-b140-3aad0db9138d/b9283093-88f1-47e6-b140-3aad0db9138d.jsonl"
      }
    }
  }
}
```

## Type Plan

Phase 2 should introduce a dedicated `src/transcript-bundle.ts` module and move transcript-manifest types there.

```ts
export type TranscriptBundleSchemaVersion = 1 | 2;

export interface TranscriptBundleProjectInfoV2 {
  folderName: string;
  fileCount: number;
  conversationCount: number;
}

export interface TranscriptBundleConversationStoreAgentV2 {
  workspaceHash: string;
  agentId: string;
  relatedComposerId: string | null;
}

export interface TranscriptBundleConversationDisplayV2 {
  name?: string;
  subtitle?: string;
  createdAt?: number;
  lastUpdatedAt?: number;
  hasUnreadMessages?: boolean;
  isArchived?: boolean;
  isDraft?: boolean;
  unifiedMode?: string;
  forceMode?: string;
}

export interface TranscriptBundleConversationV2 {
  projectKey: string;
  rootComposerId: string;
  childComposerIds: string[];
  storeAgents: TranscriptBundleConversationStoreAgentV2[];
  display?: TranscriptBundleConversationDisplayV2;
  artifactKeys: string[];
  warnings?: string[];
}

export type TranscriptBundleArtifactKind =
  | "transcript-jsonl"
  | "sidebar-composer-header"
  | "sidebar-ui-state"
  | "store-meta-row"
  | "store-blob-json"
  | "store-blob-binary";

export type TranscriptBundleArtifactSourceV2 =
  | {
      kind: "project-file";
      projectKey: string;
      relativePath: string;
    }
  | {
      kind: "state-item";
      table: "ItemTable";
      key: string;
      composerId?: string;
    }
  | {
      kind: "state-kv";
      table: "cursorDiskKV";
      key: string;
    }
  | {
      kind: "store-meta";
      workspaceHash: string;
      agentId: string;
      key: string;
    }
  | {
      kind: "store-blob";
      workspaceHash: string;
      agentId: string;
      blobId: string;
    };

export type TranscriptBundleArtifactTargetV2 =
  | {
      kind: "project-file";
      relativePath: string;
    }
  | {
      kind: "chat-store-meta";
      key: string;
    }
  | {
      kind: "chat-store-blob";
      blobId: string;
    }
  | {
      kind: "sidebar-snapshot";
      purpose: "composer-header" | "ui-state";
    };

export interface TranscriptBundleArtifactV2 {
  kind: TranscriptBundleArtifactKind;
  conversationKey: string;
  checksum: string;
  sizeBytes: number;
  encoding?: "base64";
  contentType: string;
  required: boolean;
  source: TranscriptBundleArtifactSourceV2;
  target: TranscriptBundleArtifactTargetV2;
}

export interface TranscriptBundleManifestV2 {
  schemaVersion: 2;
  type: "agent-transcripts";
  createdAt: string;
  sourceMachineId: string;
  sourceOS: "win32" | "darwin" | "linux";
  sourceProjects: Record<string, TranscriptBundleProjectInfoV2>;
  conversations: Record<string, TranscriptBundleConversationV2>;
  artifacts: Record<string, TranscriptBundleArtifactV2>;
}
```

## Canonical Artifact Keys

Artifact keys are the stable ids used inside `manifest.artifacts`. Their serialized content is uploaded as individual Gist files by converting `/` to `--`, matching the existing transport model.

| Kind | Canonical artifact key |
| --- | --- |
| Transcript JSONL | `conversations/<rootComposerId>/transcripts/<relativePath-from-project-root>` |
| Sidebar header snapshot | `conversations/<rootComposerId>/sidebar/composer/<composerId>.json` |
| Sidebar UI state snapshot | `conversations/<rootComposerId>/sidebar/ui/<slug>.json` |
| Store meta row | `conversations/<rootComposerId>/store/<workspaceHash>/<agentId>/meta/<key>.json` |
| Store JSON blob | `conversations/<rootComposerId>/store/<workspaceHash>/<agentId>/blobs/<blobId>.json` |
| Store binary blob | `conversations/<rootComposerId>/store/<workspaceHash>/<agentId>/blobs/<blobId>.bin` |

## Artifact Content Rules

| Kind | Content rule | Required |
| --- | --- | --- |
| `transcript-jsonl` | Raw JSONL file bytes. UTF-8 if valid, otherwise base64. | Yes |
| `sidebar-composer-header` | One JSON object containing the filtered `composer.composerHeaders.allComposers[]` entry for a single `composerId`. | Yes |
| `sidebar-ui-state` | Small JSON object of selected focus/visibility keys and values from `state.vscdb`. | No |
| `store-meta-row` | Decoded JSON for hex-encoded rows when possible. Preserve original bytes if a row is not decodable. | Yes |
| `store-blob-json` | Raw JSON blob bytes stored as UTF-8. | Yes |
| `store-blob-binary` | Raw blob bytes stored as base64. | Yes |

## Conversation Assembly Rules

1. A v2 conversation is rooted by a top-level transcript directory id, which is currently the best observed `composerId` anchor.
2. `childComposerIds` are derived from transcript subagent filenames and matching sidebar header snapshots when available.
3. `storeAgents` is an array because one root conversation can require zero or more per-chat store snapshots.
4. `relatedComposerId` stays `null` unless the exporter has direct evidence linking that store agent to a composer id.
5. `display` is copied from the root composer header snapshot when available and is advisory only. Import should still work when it is absent.

## Export Algorithm For Phase 2

1. Keep current project and transcript selection flow.
2. Group selected transcript files by root transcript directory.
3. For each root transcript directory:
   - create or update `conversations[rootComposerId]`
   - attach transcript artifacts
   - read `composer.composerHeaders` once and add filtered header snapshots for the root composer id and child composer ids found in the transcript tree
   - attach optional UI-state snapshots for selected keys if present
   - attach zero or more store snapshots only when the exporter has direct evidence for the relevant `workspaceHash` and `agentId`
4. For each selected `store.db`, export every row from `meta` and `blobs`.
5. Compute SHA-256 checksum over the exact serialized artifact bytes that will be uploaded.
6. Populate `sourceProjects[*].conversationCount`.

## Import Algorithm For Phase 2

1. Read `transcript-manifest.json`.
2. Branch by `schemaVersion`.
3. For `schemaVersion: 2`:
   - validate required top-level fields
   - validate that every `conversation.artifactKeys[]` entry exists in `manifest.artifacts`
   - verify checksum before writing any artifact
   - ask the user to map source `projectKey` values to local projects, as v1 already does
   - write transcript artifacts into `targetProject/agent-transcripts/...`
   - restore each selected store snapshot into `~/.cursor/chats/<workspaceHash>/<agentId>/store.db` using staged writes and rollback on failure
   - stage sidebar snapshots separately; if direct injection is not supported, surface a warning instead of failing the whole import
4. Missing optional artifacts should warn, not fail.
5. Missing required artifacts should fail the affected conversation before any partial write is finalized.

## Compatibility Strategy From `schemaVersion: 1`

- Import must continue accepting v1 manifests exactly as they exist today.
- v1 imports remain transcript-only restores:
  - map source projects
  - write JSONL files
  - do not attempt sidebar or `store.db` restoration
- Export should switch to v2 only when Phase 2 implementation lands. No separate migration command is required.
- Internally, the importer may normalize v1 into a degraded in-memory conversation model with:
  - `rootComposerId` inferred from the top-level transcript folder name when possible
  - `childComposerIds = []`
  - `storeAgents = []`
  - `artifactKeys` containing only transcript artifacts
- The UI should clearly distinguish:
  - `v2`: high-fidelity import candidate
  - `v1`: transcript-only import candidate

## Validation Rules

- `schemaVersion` must be `1` or `2`.
- `type` must remain `"agent-transcripts"`.
- Every artifact key must be unique.
- Every `conversation.artifactKeys[]` entry must exist in `manifest.artifacts`.
- Every artifact must carry `checksum`, `sizeBytes`, `contentType`, `required`, `source`, and `target`.
- Every `store-meta-row` and `store-blob-*` artifact must declare `workspaceHash` and `agentId` in `source`.
- Import must reject any v2 bundle that tries to restore a store snapshot without both `workspaceHash` and `agentId`.

## Open Assumptions And Blockers

- The observed transcript tree uses the `composerId` domain while `store.db` uses the `agentId` domain. A deterministic join was not proven from the current evidence.
- Because of that gap, Phase 2 should only restore `store.db` snapshots when the export process captured an explicit `storeAgents[]` record for the conversation.
- Sidebar metadata restoration is practical at the snapshot level, but exact runtime injection into Cursor UI state may still be best-effort on import.
