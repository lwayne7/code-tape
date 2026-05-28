import { validateRecordingPackageV1 } from "./validators.js";
import {
  RECORDING_SCHEMA_VERSION,
  type MigrateResult,
  type MigrationRegistryEntry,
  type RecordingPackageV1,
} from "./types.js";

/**
 * Migration registry. Add new entries as schema bumps land.
 *
 * Each entry takes the input shape of `from` and returns the input shape of `to`.
 * `migrateRecordingPackage` will walk the registry from the input version up to
 * the latest version, applying each migration in sequence.
 */
export const migrationRegistry: MigrationRegistryEntry[] = [
  // No migrations yet — 0.1.0 is the inaugural schema version.
];

function getSchemaVersion(input: unknown): string | null {
  if (typeof input === "object" && input !== null && "schemaVersion" in input) {
    const version = (input as { schemaVersion: unknown }).schemaVersion;
    return typeof version === "string" ? version : null;
  }
  return null;
}

export function migrateRecordingPackage(input: unknown): MigrateResult {
  const sourceVersion = getSchemaVersion(input);
  if (!sourceVersion) {
    return {
      ok: false,
      error: { code: "invalid-manifest", message: "schemaVersion missing or not a string" },
    };
  }

  let current: unknown = input;
  let currentVersion = sourceVersion;
  const applied: string[] = [];

  while (currentVersion !== RECORDING_SCHEMA_VERSION) {
    const entry = migrationRegistry.find((m) => m.from === currentVersion);
    if (!entry) {
      return {
        ok: false,
        error: { code: "unsupported-schema", schemaVersion: currentVersion },
      };
    }
    current = entry.migrate(current);
    currentVersion = entry.to;
    applied.push(`${entry.from}->${entry.to}`);
  }

  const validation = validateRecordingPackageV1(current);
  if (!validation.ok) {
    return {
      ok: false,
      error: {
        code: "invalid-manifest",
        message: validation.errors.map((e) => `${e.path}: ${e.message}`).join("; "),
      },
    };
  }
  return { ok: true, package: current as RecordingPackageV1, appliedMigrations: applied };
}
