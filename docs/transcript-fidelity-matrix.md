# Transcript Fidelity Matrix

This document defines the Phase 2 fidelity target for transcript import/export by comparing the current implementation in `src/transcripts.ts` with the local Cursor persistence signals captured in `state.vscdb`, `store.db`, and project `agent-transcripts`.

## Evidence Baseline

- `src/transcripts.ts` exports transcript/store/sidebar artifacts in `transcript-manifest.json` with `schemaVersion: 2`.
- `src/transcripts.ts` import writes transcript files into `targetProject/agent-transcripts/...`, restores store artifacts into `~/.cursor/chats/<workspace_key>/<conversation_id>/store.db`, and attempts sidebar state merge into `state.vscdb`.
- `~/.config/Cursor Nightly/User/globalStorage/state.vscdb` contains `ItemTable` and `cursorDiskKV`.
- `ItemTable.key = "composer.composerHeaders"` is a large JSON object with `allComposers` entries. Sample fields observed locally: `composerId`, `name`, `subtitle`, `createdAt`, `lastUpdatedAt`, `hasUnreadMessages`, `isArchived`, `isDraft`, `unifiedMode`, `forceMode`, `subagentInfo.parentComposerId`.
- `cursorDiskKV` contains many chat-scoped keys such as `composer.content.*`, `bubbleId:*`, and `agentKv:blob:*`.
- `~/.cursor/chats/<workspace_hash>/<agent_uuid>/store.db` contains `meta` and `blobs`.
- `store.db.meta.key = "0"` decodes from hex JSON. Sample value observed locally: `{"agentId":"9db7ef5b-eb63-48a6-bb30-3b6d6f37b5fb","latestRootBlobId":"085b6150e00711b8bf1bbee3b8abd877c127f1a1d503667055ccf9dd17929d1a","name":"New Agent","mode":"default","createdAt":1774271599578}`.
- `store.db.blobs` contains structured JSON message rows and opaque byte blobs. Sample JSON rows observed locally include:
  - `{"role":"user","content":[{"type":"text","text":"..."}],"providerOptions":{"cursor":{"requestId":"..."}}}`
  - `{"role":"assistant","content":[{"type":"reasoning","text":"..."},{"type":"text","text":"..."}]}`
  - `{"role":"tool","content":[{"type":"tool-result","toolCallId":"...","toolName":"Read","result":"..."}]}`
- Local project transcript directories under `~/.cursor/projects/home-marcelo-dev-private-cursor-sync/agent-transcripts` match the `composerId` domain, not the `store.db meta.agentId` domain. Example: `agent-transcripts/b9283093-88f1-47e6-b140-3aad0db9138d/subagents/75e6483f-fe2e-48f2-9876-37e3abb7ee96.jsonl` aligns with `composer.composerHeaders.allComposers[].composerId = "75e6483f-fe2e-48f2-9876-37e3abb7ee96"` and `subagentInfo.parentComposerId = "b9283093-88f1-47e6-b140-3aad0db9138d"`.
- No local transcript directory id matched any observed `store.db meta.agentId`.

## Current Behavior Summary

| Area | Current behavior |
| --- | --- |
| Export discovery | `enumerateTranscriptFiles()` walks `agent-transcripts` and keeps `.jsonl` files under the configured size limit. |
| Export payload | `executeExportTranscripts()` uploads transcript/store/sidebar artifacts with per-artifact checksums and conversation metadata in a v2 manifest. |
| Import payload | `executeImportTranscripts()` maps source projects to local projects, preflights artifact integrity and destination mapping, then restores selected artifacts. |
| What is still partial | Sidebar merge into `state.vscdb` is best-effort and can degrade with explicit warnings when payload/database access is unavailable. |

## Fidelity Matrix

| State element | Class | Evidence | Current v1 status | Phase 2 requirement |
| --- | --- | --- | --- | --- |
| Transcript JSONL bytes | Required | `src/transcripts.ts` already reads and writes raw `agent-transcripts/**/*.jsonl` files. | Preserved on export and import. | Keep as-is in v2. Continue preserving raw bytes and checksums. |
| Transcript identity in composer-id domain | Required | Local transcript folders and subagent files align with `composer.composerHeaders` ids such as `b9283093-...` and `75e6483f-...`. | Preserved only implicitly through path names. | Record root composer id and child composer ids explicitly in the v2 manifest. |
| Sidebar row metadata | Required | `ItemTable["composer.composerHeaders"]` includes `composerId`, `name`, `subtitle`, `createdAt`, `lastUpdatedAt`, `hasUnreadMessages`, `isArchived`, `isDraft`, `unifiedMode`, `forceMode`, `subagentInfo`. | Lost. | Export filtered header snapshots for every selected root composer and child composer. |
| Sidebar recency and display ordering signals | Required | Same `composer.composerHeaders` entries carry `lastUpdatedAt` and archive/unread flags used for list rendering decisions. | Lost. | Preserve the per-composer header fields exactly as observed, not recomputed. |
| Sidebar focus and visibility state | Optional | Local `state.vscdb` keys include `cursor/glass.sidebarVisible`, `glass/cursor.editorPanelVisibility.agent/<id>`, `workbench.panel.composerChatViewPane.<id>.hidden`, `cursor/agentLayout.sidebarLocation*`. | Lost. | Capture a small best-effort snapshot so import can restore or warn, but do not block conversation import if these keys are missing. |
| Chat-store meta root | Required | `store.db.meta.key = "0"` decodes to JSON with `agentId`, `latestRootBlobId`, `name`, `mode`, `createdAt`. | Lost. | Export every selected `meta` row, at minimum key `0`, as structured JSON plus checksum. |
| Chat-store message payload graph | Required | `store.db.blobs` contains role-bearing JSON messages and additional opaque rows referenced by the root blob. | Lost. | Export all rows from the selected per-chat `store.db`, not only JSON blobs and not only reachable blobs. |
| Rich message parts | Required | Local blobs include `reasoning`, `tool-result`, and `providerOptions.cursor.requestId`. | Lost. JSONL alone is not sufficient to prove these parts survive. | Preserve raw blob bytes and classify them as JSON or binary in the manifest. |
| `agentId` and `workspaceHash` identity domain | Required | `store.db` path is `~/.cursor/chats/<workspace_hash>/<agent_uuid>/store.db`; meta key `0` repeats the `agentId`. | Lost. | Record `workspaceHash` and `agentId` explicitly for every exported chat-store snapshot. |
| Mapping between `composerId` and `agentId` domains | Required | Local evidence shows transcript ids and sidebar ids share the composer domain, while store ids use the agent domain. No direct equality match was observed. | Missing. | Treat this as explicit manifest data. Never derive `agentId` from `composerId` or the reverse without direct evidence. |
| Additional runtime cache keys in `cursorDiskKV` | Non-goal for Phase 2 | Local keys include `composer.content.*`, `bubbleId:*`, and `agentKv:blob:*`. Some values duplicate tool results or UI context, but the minimal list/sidebar plus message fidelity target is already covered by `composer.composerHeaders` and `store.db`. | Not exported. | Do not include these in Phase 2 unless a concrete rendering gap remains after header plus store restoration. |
| Semantic decode of every opaque blob | Non-goal for Phase 2 | Some `store.db.blobs` rows start with binary prefixes before embedded JSON. | Not decoded. | Preserve bytes exactly. Do not block export/import on understanding the binary format. |

## Required Artifacts For Phase 2

- Raw transcript JSONL files exactly as currently exported.
- A filtered sidebar snapshot derived from `composer.composerHeaders` for the selected root composer and any selected child composer ids.
- A full snapshot of each selected per-chat `store.db`:
  - every row in `meta`
  - every row in `blobs`
- Explicit manifest mapping fields that carry both identity domains:
  - `rootComposerId`
  - `childComposerIds`
  - `workspaceHash`
  - `agentId`

## Optional Artifacts For Phase 2

- Best-effort UI focus and visibility keys from `state.vscdb`.
- Import warnings when those keys are unavailable or when a conversation can be restored only as transcript plus store data without exact sidebar focus restoration.

## Non-Goals For Phase 2

- Exporting the entire `state.vscdb`.
- Exporting every `cursorDiskKV` cache entry.
- Reconstructing missing `composerId <-> agentId` links by guesswork.
- Decoding proprietary binary blob payloads beyond preserving their bytes.

## Phase 2 Implications

- The bundle unit should be a root transcript conversation keyed by the root composer id, because the transcript tree already uses that domain.
- The bundle must be able to attach zero or more `store.db` chat snapshots to one root conversation because the observed store identity domain is separate.
- The exporter should only include `agentId` mappings when it has direct evidence for that conversation. Missing joins must stay explicit in the manifest instead of being silently fabricated.
