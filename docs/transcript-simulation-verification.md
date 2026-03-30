# Transcript Simulation Verification

## Scope

This playbook verifies what the current transcript export/import flow preserves today and documents the fidelity gaps that still block full Cursor chat simulation.

## Current Guarantees

- Export includes the selected `agent-transcripts/**/*.jsonl` files and a `transcript-manifest.json`.
- The exported JSONL payload is copied as exact UTF-8 bytes.
- Import writes those exact JSONL bytes into the mapped local project's `agent-transcripts/` directory.
- Import remains compatible with legacy `schemaVersion: 1` transcript manifests.
- Import tolerates higher manifest versions when they still provide the current `type`, `sourceProjects`, and `files` fields.

## Current Limitations

- Export does not capture `~/.cursor/chats/**/store.db`.
- Export does not capture `state.vscdb` sidebar metadata such as composer headers.
- Import does not restore store snapshots, sidebar snapshots, selection state, unread state, or recency ordering.
- Because of those gaps, imported data is a transcript-file backup, not a guaranteed reproduction of Cursor sidebar rows or full in-product chat rendering.

## Verification Workflow

1. Pick a source project and note the transcript file you want to validate, for example `~/.cursor/projects/<project>/agent-transcripts/<conversation>/<conversation>.jsonl`.
2. Compute a source checksum with `sha256sum <file>` and save the result.
3. Export the transcript with `Cursor Sync: Export Agent Transcripts to Private Gist`.
4. Open the created gist and inspect `transcript-manifest.json`.
5. Confirm the manifest entry for `transcripts/<project>/<relative-path>` has the expected `projectKey`, `checksum`, and `sizeBytes`.
6. Import the gist with `Cursor Sync: Import Agent Transcripts from Private Gist`.
7. Map the source project to a disposable local project and import the transcript file.
8. Compute `sha256sum` for the imported file and confirm it matches the source checksum and manifest checksum.
9. Run `diff -u <source-file> <imported-file>` or compare the files in your editor to confirm byte-for-byte equality.
10. Open the target project in Cursor and verify the file exists under `agent-transcripts/`.

## Optional Bundle v2 Evidence Check

If you are working with a fixture or future export that also contains sidebar or store snapshots, verify those artifacts separately:

1. Compare the exported sidebar snapshot against the source `composerHeaders` evidence from `state.vscdb`.
2. Compare the exported store snapshot against the source `store.db` metadata and message blobs.
3. Mark the run as an expected partial simulation if those artifacts are present in the bundle but there is still no restore path in `src/transcripts.ts`.

## Pass Criteria

- The exported manifest points to every selected transcript file.
- Source and imported transcript checksums match exactly.
- Source and imported transcript bytes are identical.
- The verification report explicitly marks sidebar/store simulation as unsupported when those artifacts are not restored.

## Failure Signals

- `transcript-manifest.json` is missing or malformed.
- A manifest checksum does not match the exported transcript payload.
- Imported transcript bytes differ from the source transcript bytes.
- Documentation or release notes imply full chat/sidebar simulation even though store/sidebar restore is still absent.

## Blocking Dependencies

Full simulation verification still depends on implementation that exports and restores `store.db` payload snapshots plus sidebar metadata snapshots. Until that exists, verification can only prove transcript-file fidelity and manifest compatibility.
