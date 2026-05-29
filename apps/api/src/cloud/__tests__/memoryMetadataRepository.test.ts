import assert from "node:assert/strict";
import test from "node:test";
import { RECORDING_SCHEMA_VERSION } from "@code-tape/recording-schema";
import { createMemoryMetadataRepository } from "../memoryMetadataRepository.js";
import type { MetadataRepository } from "../metadataRepository.js";
import type { CloudRecordingRecord, RecordingStatus } from "../types.js";

test("listRecordingsByOwner filters by owner and status, then sorts by createdAt desc", async () => {
  const metadata = createMemoryMetadataRepository();
  await seedRecording(metadata, {
    id: "rec-ready-old",
    ownerId: "owner-1",
    status: "ready",
    createdAt: "2026-05-27T00:00:00.000Z",
  });
  await seedRecording(metadata, {
    id: "rec-ready-new",
    ownerId: "owner-1",
    status: "ready",
    createdAt: "2026-05-28T00:00:00.000Z",
  });
  await seedRecording(metadata, {
    id: "rec-processing",
    ownerId: "owner-1",
    status: "processing",
    createdAt: "2026-05-29T00:00:00.000Z",
  });
  await seedRecording(metadata, {
    id: "rec-other-owner",
    ownerId: "owner-2",
    status: "ready",
    createdAt: "2026-05-30T00:00:00.000Z",
  });

  const ready = await metadata.listRecordingsByOwner({
    ownerId: "owner-1",
    statuses: ["ready"],
  });
  const visible = await metadata.listRecordingsByOwner({
    ownerId: "owner-1",
    statuses: ["ready", "processing"],
  });

  assert.deepEqual(ready.map((recording) => recording.id), ["rec-ready-new", "rec-ready-old"]);
  assert.deepEqual(visible.map((recording) => recording.id), [
    "rec-processing",
    "rec-ready-new",
    "rec-ready-old",
  ]);
  assert.ok(ready.every((recording) => recording.ownerId === "owner-1"));
});

async function seedRecording(
  metadata: MetadataRepository,
  input: {
    id: string;
    ownerId: string;
    status: RecordingStatus;
    createdAt: string;
  },
): Promise<void> {
  await metadata.createUpload({
    recording: makeRecording(input),
    assets: [],
    session: {
      id: `session-${input.id}`,
      recordingId: input.id,
      ownerId: input.ownerId,
      status: "completed",
      expiresAt: "2026-05-31T00:00:00.000Z",
      idempotencyKey: `idem-${input.id}`,
      createdAt: input.createdAt,
      completedAt: input.createdAt,
    },
  });
}

function makeRecording(input: {
  id: string;
  ownerId: string;
  status: RecordingStatus;
  createdAt: string;
}): CloudRecordingRecord {
  return {
    id: input.id,
    ownerId: input.ownerId,
    localPackageId: `local-${input.id}`,
    title: `Recording ${input.id}`,
    schemaVersion: RECORDING_SCHEMA_VERSION,
    status: input.status,
    visibility: "private",
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    completedAt: input.status === "ready" ? input.createdAt : null,
    deletedAt: null,
    durationMs: 1_000,
    initialLanguage: "javascript",
    hasAudio: false,
    hasCamera: false,
    totalSizeBytes: 1024,
    eventCount: null,
    snapshotCount: null,
    failureCode: null,
    failureMessage: null,
  };
}
