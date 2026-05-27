import assert from "node:assert/strict";
import test from "node:test";
import { canonicalStringify, sha256Hex } from "@code-tape/recording-schema/hash";
import {
  RECORDING_SCHEMA_VERSION,
  type RecordingPackageV1,
} from "@code-tape/recording-schema";
import { createCloudRecordingService } from "../cloudRecordingService.js";
import { createMemoryMetadataRepository } from "../memoryMetadataRepository.js";
import { createMemoryObjectStorage } from "../memoryObjectStorage.js";
import type { CreateUploadSessionRequest } from "../types.js";

test("createUploadSession is idempotent per owner and idempotency key", async () => {
  const service = createCloudRecordingService({
    metadata: createMemoryMetadataRepository(),
    objectStorage: createMemoryObjectStorage(),
  });
  const pkg = await makePackage();
  const request = await makeCreateSessionRequest(pkg);

  const first = await service.createUploadSession({ ownerId: "owner-1", input: request });
  const second = await service.createUploadSession({ ownerId: "owner-1", input: request });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(second.value.sessionId, first.value.sessionId);
  assert.equal(second.value.recordingId, first.value.recordingId);
  assert.equal(second.value.uploadTargets.length, request.assets.length);
  assert.ok(second.value.uploadTargets.every((target) => target.method === "PUT"));
});

test("createUploadSession rejects incomplete package asset sets", async () => {
  const service = createCloudRecordingService({
    metadata: createMemoryMetadataRepository(),
    objectStorage: createMemoryObjectStorage(),
  });
  const pkg = await makePackage();
  const request = await makeCreateSessionRequest(pkg);

  const result = await service.createUploadSession({
    ownerId: "owner-1",
    input: {
      ...request,
      assets: request.assets.filter((asset) => asset.kind !== "snapshots"),
    },
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "invalid-manifest");
  assert.match(result.error.message, /snapshots/);
});

for (const input of [
  {
    name: "unsupported asset kind",
    makeRequest: (request: CreateUploadSessionRequest): CreateUploadSessionRequest => ({
      ...request,
      assets: [
        ...request.assets,
        {
          ...request.assets[0]!,
          kind: "trace" as CreateUploadSessionRequest["assets"][number]["kind"],
        },
      ],
    }),
    message: /unsupported asset kind: trace/,
  },
  {
    name: "duplicate asset kind",
    makeRequest: (request: CreateUploadSessionRequest): CreateUploadSessionRequest => ({
      ...request,
      assets: [...request.assets, { ...request.assets[0]! }],
    }),
    message: /duplicate asset kind: manifest/,
  },
  {
    name: "invalid asset checksum",
    makeRequest: (request: CreateUploadSessionRequest): CreateUploadSessionRequest => ({
      ...request,
      assets: request.assets.map((asset) =>
        asset.kind === "manifest" ? { ...asset, sha256: "sha256-placeholder" } : asset,
      ),
    }),
    message: /invalid asset checksum: manifest/,
  },
  {
    name: "invalid asset size",
    makeRequest: (request: CreateUploadSessionRequest): CreateUploadSessionRequest => ({
      ...request,
      assets: request.assets.map((asset) =>
        asset.kind === "manifest" ? { ...asset, sizeBytes: -1 } : asset,
      ),
    }),
    message: /invalid asset size: manifest/,
  },
  {
    name: "empty asset mime type",
    makeRequest: (request: CreateUploadSessionRequest): CreateUploadSessionRequest => ({
      ...request,
      assets: request.assets.map((asset) =>
        asset.kind === "manifest" ? { ...asset, mimeType: " " } : asset,
      ),
    }),
    message: /invalid asset mime type: manifest/,
  },
] as const) {
  test(`createUploadSession rejects ${input.name}`, async () => {
    const service = createCloudRecordingService({
      metadata: createMemoryMetadataRepository(),
      objectStorage: createMemoryObjectStorage(),
    });
    const pkg = await makePackage();
    const request = await makeCreateSessionRequest(pkg);

    const result = await service.createUploadSession({
      ownerId: "owner-1",
      input: input.makeRequest(request),
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "invalid-manifest");
    assert.match(result.error.message, input.message);
  });
}

test("completeUpload does not regress a completed recording back to processing", async () => {
  const metadata = createMemoryMetadataRepository();
  const service = createCloudRecordingService({
    metadata,
    objectStorage: createMemoryObjectStorage(),
  });
  const pkg = await makePackage();
  const request = await makeCreateSessionRequest(pkg);
  const created = await service.createUploadSession({ ownerId: "owner-1", input: request });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const first = await service.completeUpload({
    ownerId: "owner-1",
    sessionId: created.value.sessionId,
    input: { uploadedAssets: request.assets },
  });
  assert.equal(first.ok, true);
  const processing = await metadata.getRecording(created.value.recordingId);
  assert.ok(processing);
  await metadata.updateRecording({
    ...processing,
    status: "ready",
    completedAt: "2026-05-27T00:02:00.000Z",
    updatedAt: "2026-05-27T00:02:00.000Z",
    eventCount: 0,
    snapshotCount: 0,
  });

  const second = await service.completeUpload({
    ownerId: "owner-1",
    sessionId: created.value.sessionId,
    input: { uploadedAssets: request.assets },
  });
  const recording = await metadata.getRecording(created.value.recordingId);

  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.value.status, "ready");
  assert.equal(recording?.status, "ready");
  assert.equal(recording?.updatedAt, "2026-05-27T00:02:00.000Z");
});

async function makePackage(): Promise<RecordingPackageV1> {
  const events: RecordingPackageV1["events"] = [];
  const snapshots: RecordingPackageV1["snapshots"] = [];
  return {
    schemaVersion: RECORDING_SCHEMA_VERSION,
    manifest: {
      packageId: "pkg-1",
      schemaVersion: RECORDING_SCHEMA_VERSION,
      status: "complete",
      createdAt: "2026-05-27T00:00:00.000Z",
      completedAt: "2026-05-27T00:01:00.000Z",
      checksums: {
        eventsSha256: await sha256Hex(canonicalStringify(events)),
        snapshotsSha256: await sha256Hex(canonicalStringify(snapshots)),
      },
    },
    meta: {
      id: "rec-1",
      title: "Cloud infra demo",
      createdAt: "2026-05-27T00:00:00.000Z",
      durationMs: 1000,
      appVersion: "0.0.0",
      ownerId: null,
      creatorInfo: null,
      initialLanguage: "javascript",
      initialFontSize: 14,
      initialTheme: "dark",
      mediaCapability: {
        audio: "unsupported",
        camera: "unsupported",
        selectedAudioDeviceId: null,
        selectedCameraDeviceId: null,
      },
    },
    events,
    snapshots,
    media: null,
  };
}

async function makeCreateSessionRequest(pkg: RecordingPackageV1): Promise<CreateUploadSessionRequest> {
  return {
    idempotencyKey: "idem-1",
    localPackageId: pkg.manifest.packageId,
    title: pkg.meta.title,
    schemaVersion: pkg.schemaVersion,
    durationMs: pkg.meta.durationMs,
    initialLanguage: pkg.meta.initialLanguage,
    hasAudio: false,
    hasCamera: false,
    assets: await Promise.all([
      asset("manifest", pkg.manifest),
      asset("meta", pkg.meta),
      asset("events", pkg.events),
      asset("snapshots", pkg.snapshots),
    ]),
  };
}

async function asset(kind: "manifest" | "meta" | "events" | "snapshots", value: unknown) {
  const body = canonicalStringify(value);
  return {
    kind,
    sha256: await sha256Hex(body),
    sizeBytes: new TextEncoder().encode(body).byteLength,
    mimeType: "application/json",
  };
}
