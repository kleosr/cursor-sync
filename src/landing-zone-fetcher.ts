/**
 * Fetchers (Gist, HTTP, local copy) materialize a directory that contains
 * `sync-manifest.json` and payload files. The sync engine only consumes that directory.
 */
export interface LandingZoneFetcher {
  /** For logging / telemetry only */
  readonly label: string;
  /** Writes a complete landing zone tree under `destinationDirectory`. */
  materialize(destinationDirectory: string): Promise<void>;
}
