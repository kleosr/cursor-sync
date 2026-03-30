# Transcript Simulation Verification

## Scope

This playbook verifies transcript bundle restore behavior, including transcript bytes, store restore paths, and sidebar/state restoration outcomes.

## Current Guarantees

- Export includes the selected `agent-transcripts/**/*.jsonl` files and a `transcript-manifest.json` (`schemaVersion: 2`).
- The exported JSONL payload is copied as exact UTF-8 bytes.
- Import writes those exact JSONL bytes into the mapped local project's `agent-transcripts/` directory.
- Import validates artifact presence and checksums before writing.
- Import restores `store.db` artifacts to `~/.cursor/chats/<mapped-workspace-key>/<conversation-id>/store.db`.
- Import restores sidebar metadata JSON sidecars per conversation.
- Import attempts to merge sidebar composer headers into local `state.vscdb` when payload and DB are available.
- Import remains compatible with legacy `schemaVersion: 1` transcript manifests.

## Verification Workflow

1. Pick a source project and note the transcript file you want to validate, for example `~/.cursor/projects/<project>/agent-transcripts/<conversation>/<conversation>.jsonl`.
2. Compute a source checksum with `sha256sum <file>` and save the result.
3. Export the transcript with `Cursor Sync: Export Agent Transcripts to Private Gist`.
4. Open the created gist and inspect `transcript-manifest.json`.
5. Confirm transcript artifact entries have expected `projectKey`, `sourceRelativePath`, `checksum`, and `sizeBytes`.
6. Confirm store artifact entries include `sourceWorkspaceKey` when present.
7. Import the gist with `Cursor Sync: Import Agent Transcripts from Private Gist`.
8. Map source projects to target projects and, if prompted, map source workspace keys to local `~/.cursor/chats` workspace keys.
9. Select conversations to import.
10. Compute `sha256sum` for the imported transcript file and confirm it matches source and manifest checksums.
11. Verify restored store path exists: `~/.cursor/chats/<mapped-workspace-key>/<conversation-id>/store.db`.
12. Verify sidebar sidecar exists at `agent-transcripts/<conversation-id>/cursor-sidebar-metadata.json`.
13. Inspect import completion output for `Restored: transcript files ..., store.db ..., sidebar JSON ..., state.vscdb merges ...`.
14. If state merge is skipped/partial, confirm warning text explains why.
## Pass Criteria

- The exported manifest points to every selected transcript/store/sidebar artifact.
- Source and imported transcript checksums match exactly.
- Source and imported transcript bytes are identical.
- Store artifacts restore into deterministic `~/.cursor/chats/<workspace>/<conversation>/store.db` targets.
- Completion output reports artifact breakdown and any state-merge degradation reasons.

## Failure Signals

- `transcript-manifest.json` is missing or malformed.
- A manifest checksum does not match an exported artifact payload.
- Imported transcript bytes differ from the source transcript bytes.
- Store artifacts are routed to non-deterministic or incorrect chats paths.
- Sidebar state merge is expected but not attempted, or fails silently without warning output.
