import assert from "node:assert/strict";
import test from "node:test";
import { canonicalStringify, sha256Hex } from "@code-tape/recording-schema/hash";
import {
  RECORDING_SCHEMA_VERSION,
  sha256Blob,
  type RecordingPackageV1,
} from "@code-tape/recording-schema";
import { createCloudRecordingService } from "../cloudRecordingService.js";
import { createMemoryMetadataRepository } from "../memoryMetadataRepository.js";
import { createMemoryObjectStorage } from "../memoryObjectStorage.js";
import { processNextRecordingValidationJob } from "../validationWorker.js";
import type { CreateUploadSessionRequest } from "../types.js";

test("validation worker marks a completed upload ready after schema and checksum checks", async () => {
  const metadata = createMemoryMetadataRepository();
  const objectStorage = createMemoryObjectStorage();
  const service = createCloudRecordingService({ metadata, objectStorage });
  const pkg = await makePackage();
  const created = await service.createUploadSession({
    ownerId: "owner-1",
    input: await makeCreateSessionRequest(pkg),
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  await uploadPackageAssets(objectStorage, created.value.uploadTargets, pkg);

  const completed = await service.completeUpload({
    ownerId: "owner-1",
    sessionId: created.value.sessionId,
    input: {
      uploadedAssets: await makeUploadedAssets(pkg),
    },
  });
  assert.equal(completed.ok, true);

  const job = await processNextRecordingValidationJob({ metadata, objectStorage });

  assert.equal(job.ok, true);
  if (!job.ok) return;
  assert.equal(job.recording.status, "ready");
  assert.ok(job.recording.completedAt);
});

test("validation worker keeps corrupt packages out of ready state", async () => {
  const metadata = createMemoryMetadataRepository();
  const objectStorage = createMemoryObjectStorage();
  const service = createCloudRecordingService({ metadata, objectStorage });
  const pkg = await makePackage();
  const created = await service.createUploadSession({
    ownerId: "owner-1",
    input: await makeCreateSessionRequest(pkg),
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  await uploadPackageAssets(objectStorage, created.value.uploadTargets, {
    ...pkg,
    events: [
      {
        id: "bad",
        seq: 1,
        timestampMs: 1,
        source: "editor",
        track: "main",
        type: "content-change",
        payload: {
          fileId: "main",
          version: 1,
          code: "changed after checksum",
          contentHash: "x",
          language: "javascript",
          changeReason: "input",
          changeCount: 1,
          flushedBy: "debounce",
        },
      },
    ],
  } satisfies RecordingPackageV1);
  const completed = await service.completeUpload({
    ownerId: "owner-1",
    sessionId: created.value.sessionId,
    input: {
      uploadedAssets: await makeUploadedAssets(pkg),
    },
  });
  assert.equal(completed.ok, true);

  const job = await processNextRecordingValidationJob({ metadata, objectStorage });

  assert.equal(job.ok, false);
  if (job.ok || !("recording" in job)) return;
  assert.equal(job.recording.status, "failed");
  assert.equal(job.recording.failureCode, "checksum-mismatch");
});

test("validation worker validates media assets without text-decoding binary content", async () => {
  const metadata = createMemoryMetadataRepository();
  const objectStorage = createMemoryObjectStorage();
  const service = createCloudRecordingService({ metadata, objectStorage });
  const mediaBytes = new TextEncoder().encode("media");
  const mediaBlob = new Blob([mediaBytes], { type: "video/webm" });
  const pkg = await makePackage({ mediaSha256: await sha256Blob(mediaBlob) });
  const created = await service.createUploadSession({
    ownerId: "owner-1",
    input: await makeCreateSessionRequest(pkg, { mediaBytes }),
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  await uploadPackageAssets(objectStorage, created.value.uploadTargets, pkg, { mediaBytes });
  const completed = await service.completeUpload({
    ownerId: "owner-1",
    sessionId: created.value.sessionId,
    input: {
      uploadedAssets: await makeUploadedAssets(pkg, { mediaBytes }),
    },
  });
  assert.equal(completed.ok, true);

  const job = await processNextRecordingValidationJob({ metadata, objectStorage });

  assert.equal(job.ok, true);
  if (!job.ok) return;
  assert.equal(job.recording.status, "ready");
});

test("validation worker validates thumbnail assets without text-decoding binary content", async () => {
  const metadata = createMemoryMetadataRepository();
  const objectStorage = createMemoryObjectStorage();
  const service = createCloudRecordingService({ metadata, objectStorage });
  const thumbnailBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0xff, 0x80, 0x57, 0x45]);
  const pkg = await makePackage();
  const created = await service.createUploadSession({
    ownerId: "owner-1",
    input: await makeCreateSessionRequest(pkg, { thumbnailBytes }),
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  await uploadPackageAssets(objectStorage, created.value.uploadTargets, pkg, { thumbnailBytes });
  const completed = await service.completeUpload({
    ownerId: "owner-1",
    sessionId: created.value.sessionId,
    input: {
      uploadedAssets: await makeUploadedAssets(pkg, { thumbnailBytes }),
    },
  });
  assert.equal(completed.ok, true);

  const job = await processNextRecordingValidationJob({ metadata, objectStorage });

  assert.equal(job.ok, true);
  if (!job.ok) return;
  assert.equal(job.recording.status, "ready");
});

test("validation worker marks checksum-matching malformed JSON packages failed", async () => {
  const metadata = createMemoryMetadataRepository();
  const objectStorage = createMemoryObjectStorage();
  const service = createCloudRecordingService({ metadata, objectStorage });
  const pkg = await makePackage();
  const request = await makeCreateSessionRequest(pkg);
  const malformedManifest = '{"packageId":';
  const malformedManifestBytes = new TextEncoder().encode(malformedManifest);
  const assets = await Promise.all(
    request.assets.map(async (asset) =>
      asset.kind === "manifest"
        ? {
            ...asset,
            sha256: await sha256Hex(malformedManifest),
            sizeBytes: malformedManifestBytes.byteLength,
          }
        : asset,
    ),
  );
  const created = await service.createUploadSession({
    ownerId: "owner-1",
    input: { ...request, assets },
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  await uploadPackageAssets(objectStorage, created.value.uploadTargets, pkg);
  const manifestTarget = created.value.uploadTargets.find((target) => target.kind === "manifest");
  assert.ok(manifestTarget);
  await objectStorage.putBySignedUrl(manifestTarget.url, malformedManifestBytes, {
    contentType: manifestTarget.headers["content-type"] ?? "application/json",
  });
  const completed = await service.completeUpload({
    ownerId: "owner-1",
    sessionId: created.value.sessionId,
    input: { uploadedAssets: assets },
  });
  assert.equal(completed.ok, true);

  const job = await processNextRecordingValidationJob({ metadata, objectStorage });

  assert.equal(job.ok, false);
  if (job.ok || !("recording" in job)) return;
  assert.equal(job.recording.status, "failed");
  assert.equal(job.recording.failureCode, "invalid-manifest");
  assert.match(job.recording.failureMessage ?? "", /malformed JSON/);
});

async function makePackage(input: { mediaSha256?: string } = {}): Promise<RecordingPackageV1> {
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
        ...(input.mediaSha256 ? { mediaSha256: input.mediaSha256 } : {}),
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

async function makeCreateSessionRequest(
  pkg: RecordingPackageV1,
  input: { mediaBytes?: Uint8Array; thumbnailBytes?: Uint8Array } = {},
) {
  return {
    idempotencyKey: "idem-1",
    localPackageId: pkg.manifest.packageId,
    title: pkg.meta.title,
    schemaVersion: pkg.schemaVersion,
    durationMs: pkg.meta.durationMs,
    initialLanguage: pkg.meta.initialLanguage,
    hasAudio: false,
    hasCamera: false,
    assets: await makeUploadedAssets(pkg, input),
  };
}

async function makeUploadedAssets(
  pkg: RecordingPackageV1,
  input: { mediaBytes?: Uint8Array; thumbnailBytes?: Uint8Array } = {},
): Promise<CreateUploadSessionRequest["assets"]> {
  const assets: CreateUploadSessionRequest["assets"] = await Promise.all([
    asset("manifest", pkg.manifest),
    asset("meta", pkg.meta),
    asset("events", pkg.events),
    asset("snapshots", pkg.snapshots),
  ]);
  if (input.mediaBytes) {
    assets.push({
      kind: "media",
      sha256: pkg.manifest.checksums.mediaSha256 ?? "",
      sizeBytes: input.mediaBytes.byteLength,
      mimeType: "video/webm",
    });
  }
  if (input.thumbnailBytes) {
    assets.push({
      kind: "thumbnail",
      sha256: await sha256Blob(
        new Blob([toArrayBuffer(input.thumbnailBytes)], { type: "image/webp" }),
      ),
      sizeBytes: input.thumbnailBytes.byteLength,
      mimeType: "image/webp",
    });
  }
  return assets;
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

async function uploadPackageAssets(
  objectStorage: ReturnType<typeof createMemoryObjectStorage>,
  targets: Array<{ kind: string; url: string; headers: Record<string, string> }>,
  pkg: RecordingPackageV1,
  input: { mediaBytes?: Uint8Array; thumbnailBytes?: Uint8Array } = {},
) {
  const values: Record<string, unknown> = {
    manifest: pkg.manifest,
    meta: pkg.meta,
    events: pkg.events,
    snapshots: pkg.snapshots,
  };
  await Promise.all(
    targets.map((target) => {
      let body: Uint8Array;
      if (target.kind === "media" && input.mediaBytes) {
        body = input.mediaBytes;
      } else if (target.kind === "thumbnail" && input.thumbnailBytes) {
        body = input.thumbnailBytes;
      } else {
        body = new TextEncoder().encode(canonicalStringify(values[target.kind]));
      }
      return objectStorage.putBySignedUrl(target.url, body, {
        contentType: target.headers["content-type"] ?? "application/octet-stream",
      });
    }),
  );
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
