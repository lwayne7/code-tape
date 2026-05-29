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
import {
  MAX_RECORDING_MEDIA_SIZE_BYTES,
  MAX_RECORDING_TOTAL_ASSET_SIZE_BYTES,
  type CreateUploadSessionRequest,
} from "../types.js";

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

test("createUploadSession rejects upload session with duration exceeding limit", async () => {
  const metadata = createMemoryMetadataRepository();
  const objectStorage = createMemoryObjectStorage();
  const service = createCloudRecordingService({ metadata, objectStorage });
  const pkg = await makePackage();
  
  // Set duration to 16 minutes
  pkg.meta.durationMs = 16 * 60 * 1000;
  
  const created = await service.createUploadSession({
    ownerId: "owner-1",
    input: await makeCreateSessionRequest(pkg),
  });
  
  assert.equal(created.ok, false);
  if (created.ok) return;
  assert.equal(created.error.code, "quota-exceeded");
  assert.match(created.error.message, /duration exceeds budget limit/);
});

test("validation worker rejects package with duration exceeding limit during worker validation", async () => {
  const metadata = createMemoryMetadataRepository();
  const objectStorage = createMemoryObjectStorage();
  const service = createCloudRecordingService({ metadata, objectStorage });
  const pkg = await makePackage();
  
  // Set duration in meta to 16 minutes
  pkg.meta.durationMs = 16 * 60 * 1000;
  
  // Create upload session with valid durationMs in the request, but with the checksum of the 16-min meta package
  const request = await makeCreateSessionRequest(pkg);
  request.durationMs = 1000; // override to pass session creation check
  
  const created = await service.createUploadSession({
    ownerId: "owner-1",
    input: request,
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
  assert.equal(job.ok, false);
  if (job.ok || !("recording" in job)) return;
  assert.equal(job.recording.status, "failed");
  assert.equal(job.recording.failureCode, "quota-exceeded");
  assert.match(job.recording.failureMessage ?? "", /duration exceeds budget limit/);
});

test("validation worker rejects package with event count exceeding limit during worker validation", async () => {
  const metadata = createMemoryMetadataRepository();
  const objectStorage = createMemoryObjectStorage();
  const service = createCloudRecordingService({ metadata, objectStorage });
  
  // Create 20001 events of a valid type (selection-change)
  const events = Array.from({ length: 20001 }, (_, i) => ({
    id: `ev-${i}`,
    seq: i + 1,
    timestampMs: i,
    source: "editor",
    track: "main",
    type: "selection-change",
    payload: { cursor: null, selection: null },
  }));
  
  const pkg = await makePackage();
  pkg.events = events as any;
  pkg.manifest.checksums.eventsSha256 = await sha256Hex(canonicalStringify(events));
  
  // Create upload session
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
  assert.equal(job.ok, false);
  if (job.ok || !("recording" in job)) return;
  assert.equal(job.recording.status, "failed");
  assert.equal(job.recording.failureCode, "quota-exceeded");
  assert.match(job.recording.failureMessage ?? "", /event count exceeds budget limit/);
});

test("createUploadSession rejects upload session with media exceeding limit", async () => {
  const metadata = createMemoryMetadataRepository();
  const objectStorage = createMemoryObjectStorage();
  const service = createCloudRecordingService({ metadata, objectStorage });
  const pkg = await makePackage();
  
  const request = await makeCreateSessionRequest(pkg);
  request.assets.push({
    kind: "media",
    sha256: "0000000000000000000000000000000000000000000000000000000000000000",
    sizeBytes: 200 * 1024 * 1024 + 1,
    mimeType: "video/webm",
  });
  
  const created = await service.createUploadSession({
    ownerId: "owner-1",
    input: request,
  });
  
  assert.equal(created.ok, false);
  if (created.ok) return;
  assert.equal(created.error.code, "quota-exceeded");
  assert.match(created.error.message, /media size exceeds budget limit/);
});

test("createUploadSession rejects upload session with total size exceeding limit", async () => {
  const metadata = createMemoryMetadataRepository();
  const objectStorage = createMemoryObjectStorage();
  const service = createCloudRecordingService({ metadata, objectStorage });
  const pkg = await makePackage();
  
  const request = await makeCreateSessionRequest(pkg);
  request.assets.push({
    kind: "media",
    sha256: "0000000000000000000000000000000000000000000000000000000000000000",
    sizeBytes: 200 * 1024 * 1024, // exactly 200MB (passes media check)
    mimeType: "video/webm",
  });
  request.assets.push({
    kind: "thumbnail",
    sha256: "0000000000000000000000000000000000000000000000000000000000000000",
    sizeBytes: 51 * 1024 * 1024, // 51MB (total becomes > 250MB)
    mimeType: "image/webp",
  });
  
  const created = await service.createUploadSession({
    ownerId: "owner-1",
    input: request,
  });
  
  assert.equal(created.ok, false);
  if (created.ok) return;
  assert.equal(created.error.code, "quota-exceeded");
  assert.match(created.error.message, /total asset size exceeds budget limit/);
});

test("validation worker rejects existing media object exceeding the media size limit", async () => {
  const metadata = createMemoryMetadataRepository();
  const objectStorage = createMemoryObjectStorage();
  const service = createCloudRecordingService({ metadata, objectStorage });
  const mediaBytes = new Uint8Array(100);
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

  const originalGetObject = objectStorage.getObject.bind(objectStorage);
  objectStorage.getObject = async (key: string) => {
    const object = await originalGetObject(key);
    return object && key.includes("media")
      ? { ...object, sizeBytes: MAX_RECORDING_MEDIA_SIZE_BYTES + 1 }
      : object;
  };

  const job = await processNextRecordingValidationJob({ metadata, objectStorage });
  assert.equal(job.ok, false);
  if (job.ok || !("recording" in job)) return;
  assert.equal(job.recording.status, "failed");
  assert.equal(job.recording.failureCode, "quota-exceeded");
  assert.match(job.recording.failureMessage ?? "", /media size exceeds budget limit/);
});

test("validation worker rejects existing assets exceeding the total size limit", async () => {
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

  const assets = await metadata.listAssets(created.value.recordingId);
  const thumbnailAsset = assets.find((assetRecord) => assetRecord.kind === "thumbnail");
  assert.ok(thumbnailAsset);
  await metadata.updateAsset({
    ...thumbnailAsset,
    sizeBytes: MAX_RECORDING_TOTAL_ASSET_SIZE_BYTES,
  });

  const originalGetObject = objectStorage.getObject.bind(objectStorage);
  objectStorage.getObject = async (key: string) => {
    const object = await originalGetObject(key);
    return object && key.includes("thumbnail")
      ? { ...object, sizeBytes: MAX_RECORDING_TOTAL_ASSET_SIZE_BYTES }
      : object;
  };

  const job = await processNextRecordingValidationJob({ metadata, objectStorage });
  assert.equal(job.ok, false);
  if (job.ok || !("recording" in job)) return;
  assert.equal(job.recording.status, "failed");
  assert.equal(job.recording.failureCode, "quota-exceeded");
  assert.match(job.recording.failureMessage ?? "", /total asset size exceeds budget limit/);
});

test("validation worker allows missing optional media asset and degrades gracefully", async () => {
  const metadata = createMemoryMetadataRepository();
  const objectStorage = createMemoryObjectStorage();
  const service = createCloudRecordingService({ metadata, objectStorage });
  const pkg = await makePackage();
  
  // Set initial recording hasAudio/hasCamera as true
  const created = await service.createUploadSession({
    ownerId: "owner-1",
    input: {
      ...(await makeCreateSessionRequest(pkg)),
      hasAudio: true,
      hasCamera: true,
    },
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  // Upload assets, but do not upload media since it's optional
  await uploadPackageAssets(objectStorage, created.value.uploadTargets, pkg);

  const completed = await service.completeUpload({
    ownerId: "owner-1",
    sessionId: created.value.sessionId,
    input: {
      uploadedAssets: await makeUploadedAssets(pkg), // no media
    },
  });
  assert.equal(completed.ok, true);

  const job = await processNextRecordingValidationJob({ metadata, objectStorage });
  assert.equal(job.ok, true);
  if (!job.ok) return;
  assert.equal(job.recording.status, "ready");
  assert.equal(job.recording.hasAudio, false);
  assert.equal(job.recording.hasCamera, false);
});

test("validation worker allows missing optional media asset even if declared metadata size exceeds limit", async () => {
  const metadata = createMemoryMetadataRepository();
  const objectStorage = createMemoryObjectStorage();
  const service = createCloudRecordingService({ metadata, objectStorage });
  
  const mediaBytes = new Uint8Array(100);
  const mediaBlob = new Blob([mediaBytes], { type: "video/webm" });
  const pkg = await makePackage({ mediaSha256: await sha256Blob(mediaBlob) });

  // Create session request with valid media size (100 bytes) to bypass session creation check
  const created = await service.createUploadSession({
    ownerId: "owner-1",
    input: {
      ...(await makeCreateSessionRequest(pkg, { mediaBytes })),
      hasAudio: true,
      hasCamera: true,
    },
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  // Upload assets, but do not upload media since it's optional
  const jsonTargets = created.value.uploadTargets.filter(
    (t) => t.kind !== "media" && t.kind !== "thumbnail",
  );
  await uploadPackageAssets(objectStorage, jsonTargets, pkg);

  const completed = await service.completeUpload({
    ownerId: "owner-1",
    sessionId: created.value.sessionId,
    input: {
      uploadedAssets: await makeUploadedAssets(pkg, { mediaBytes }),
    },
  });
  assert.equal(completed.ok, true);

  // Manually update the media asset sizeBytes in metadata repository to 200MB + 1
  const assets = await metadata.listAssets(created.value.recordingId);
  const mediaAsset = assets.find((a) => a.kind === "media");
  assert.ok(mediaAsset);
  await metadata.updateAsset({
    ...mediaAsset,
    sizeBytes: 200 * 1024 * 1024 + 1,
  });

  const job = await processNextRecordingValidationJob({ metadata, objectStorage });
  assert.equal(job.ok, true);
  if (!job.ok) return;
  assert.equal(job.recording.status, "ready");
  assert.equal(job.recording.hasAudio, false);
  assert.equal(job.recording.hasCamera, false);

  const updatedAssets = await metadata.listAssets(created.value.recordingId);
  const updatedMediaAsset = updatedAssets.find((asset) => asset.kind === "media");
  const manifestAsset = updatedAssets.find((asset) => asset.kind === "manifest");
  assert.ok(updatedMediaAsset);
  assert.ok(manifestAsset);
  assert.equal(updatedMediaAsset.validatedAt, null);
  assert.notEqual(manifestAsset.validatedAt, null);
});

test("validation worker allows exact budget limits (15 mins duration, 20000 events, 200MB media, 250MB total size)", async () => {
  const metadata = createMemoryMetadataRepository();
  const objectStorage = createMemoryObjectStorage();
  const service = createCloudRecordingService({ metadata, objectStorage });

  // 20000 events
  const events = Array.from({ length: 20000 }, (_, i) => ({
    id: `ev-${i}`,
    seq: i + 1,
    timestampMs: i,
    source: "editor",
    track: "main",
    type: "selection-change",
    payload: { cursor: null, selection: null },
  }));

  const pkg = await makePackage();
  pkg.events = events as any;
  pkg.manifest.checksums.eventsSha256 = await sha256Hex(canonicalStringify(events));
  pkg.meta.durationMs = 15 * 60 * 1000; // exactly 15 mins

  // Setup virtual media size and small mock bytes for fast checksumming
  const mediaSizeBytes = 200 * 1024 * 1024; // exactly 200MB
  const mediaBytes = new Uint8Array(100); // only 100 bytes physically
  const mediaSha256 = await sha256Blob(new Blob([mediaBytes], { type: "video/webm" }));
  pkg.manifest.checksums.mediaSha256 = mediaSha256;

  // Setup final JSON bodies and sizes
  const manifestBody = canonicalStringify(pkg.manifest);
  const metaBody = canonicalStringify(pkg.meta);
  const eventsBody = canonicalStringify(pkg.events);
  const snapshotsBody = canonicalStringify(pkg.snapshots);

  const manifestSize = new TextEncoder().encode(manifestBody).byteLength;
  const metaSize = new TextEncoder().encode(metaBody).byteLength;
  const eventsSize = new TextEncoder().encode(eventsBody).byteLength;
  const snapshotsSize = new TextEncoder().encode(snapshotsBody).byteLength;

  const jsonSizeBytes = manifestSize + metaSize + eventsSize + snapshotsSize;

  // Setup thumbnail size and mock bytes to reach exactly 250MB total size virtually
  const targetTotalSizeBytes = 250 * 1024 * 1024; // exactly 250MB
  const thumbnailSizeBytes = targetTotalSizeBytes - mediaSizeBytes - jsonSizeBytes;
  assert.ok(thumbnailSizeBytes > 0);

  const thumbnailBytes = new Uint8Array(100); // only 100 bytes physically
  const thumbnailSha256 = await sha256Blob(new Blob([thumbnailBytes], { type: "image/webp" }));

  // Intercept getObject to return virtual size for media and thumbnail assets
  const originalGetObject = objectStorage.getObject.bind(objectStorage);
  objectStorage.getObject = async (key: string) => {
    const obj = await originalGetObject(key);
    if (obj) {
      if (key.includes("media")) {
        return { ...obj, sizeBytes: mediaSizeBytes };
      }
      if (key.includes("thumbnail")) {
        return { ...obj, sizeBytes: thumbnailSizeBytes };
      }
    }
    return obj;
  };

  const assets = [
    { kind: "manifest" as const, sha256: await sha256Hex(manifestBody), sizeBytes: manifestSize, mimeType: "application/json" },
    { kind: "meta" as const, sha256: await sha256Hex(metaBody), sizeBytes: metaSize, mimeType: "application/json" },
    { kind: "events" as const, sha256: await sha256Hex(eventsBody), sizeBytes: eventsSize, mimeType: "application/json" },
    { kind: "snapshots" as const, sha256: await sha256Hex(snapshotsBody), sizeBytes: snapshotsSize, mimeType: "application/json" },
    { kind: "media" as const, sha256: mediaSha256, sizeBytes: mediaSizeBytes, mimeType: "video/webm" },
    { kind: "thumbnail" as const, sha256: thumbnailSha256, sizeBytes: thumbnailSizeBytes, mimeType: "image/webp" },
  ];

  const created = await service.createUploadSession({
    ownerId: "owner-1",
    input: {
      idempotencyKey: "idem-exact",
      localPackageId: pkg.manifest.packageId,
      title: pkg.meta.title,
      schemaVersion: pkg.schemaVersion,
      durationMs: pkg.meta.durationMs,
      initialLanguage: pkg.meta.initialLanguage,
      hasAudio: false,
      hasCamera: false,
      assets,
    },
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  // Upload ALL assets including media and thumbnail
  await uploadPackageAssets(objectStorage, created.value.uploadTargets, pkg, { mediaBytes, thumbnailBytes });

  const completed = await service.completeUpload({
    ownerId: "owner-1",
    sessionId: created.value.sessionId,
    input: {
      uploadedAssets: assets,
    },
  });
  assert.equal(completed.ok, true);

  const job = await processNextRecordingValidationJob({ metadata, objectStorage });
  assert.equal(job.ok, true);
  if (!job.ok) return;
  assert.equal(job.recording.status, "ready");
  assert.equal(job.recording.eventCount, 20000);
});

test("validation worker allows missing optional media asset even if it was declared in upload session and degrades gracefully", async () => {
  const metadata = createMemoryMetadataRepository();
  const objectStorage = createMemoryObjectStorage();
  const service = createCloudRecordingService({ metadata, objectStorage });
  
  const mediaBytes = new Uint8Array(100);
  const mediaBlob = new Blob([mediaBytes], { type: "video/webm" });
  const pkg = await makePackage({ mediaSha256: await sha256Blob(mediaBlob) });

  // Create session request declaring media asset
  const created = await service.createUploadSession({
    ownerId: "owner-1",
    input: {
      ...(await makeCreateSessionRequest(pkg, { mediaBytes })),
      hasAudio: true,
      hasCamera: true,
    },
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  // Upload ONLY JSON assets (omit media)
  const jsonTargets = created.value.uploadTargets.filter((t) => t.kind !== "media");
  await uploadPackageAssets(objectStorage, jsonTargets, pkg);

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
  assert.equal(job.recording.hasAudio, false);
  assert.equal(job.recording.hasCamera, false);

  const assets = await metadata.listAssets(created.value.recordingId);
  const mediaAsset = assets.find((asset) => asset.kind === "media");
  const manifestAsset = assets.find((asset) => asset.kind === "manifest");
  assert.ok(mediaAsset);
  assert.ok(manifestAsset);
  assert.equal(mediaAsset.validatedAt, null);
  assert.notEqual(manifestAsset.validatedAt, null);
});

test("validation worker allows missing optional thumbnail and indexes assets even if they were declared in upload session", async () => {
  const metadata = createMemoryMetadataRepository();
  const objectStorage = createMemoryObjectStorage();
  const service = createCloudRecordingService({ metadata, objectStorage });
  
  const thumbnailBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0xff, 0x80, 0x57, 0x45]);
  const pkg = await makePackage();

  // Create session request declaring thumbnail and indexes
  const created = await service.createUploadSession({
    ownerId: "owner-1",
    input: {
      ...(await makeCreateSessionRequest(pkg, { thumbnailBytes })),
      assets: [
        ...(await makeUploadedAssets(pkg, { thumbnailBytes })),
        {
          kind: "indexes",
          sha256: await sha256Hex("indexes"),
          sizeBytes: 10,
          mimeType: "application/json",
        },
      ],
    },
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  // Upload ONLY required JSON assets (omit thumbnail and indexes)
  const requiredTargets = created.value.uploadTargets.filter(
    (t) => t.kind !== "thumbnail" && t.kind !== "indexes",
  );
  await uploadPackageAssets(objectStorage, requiredTargets, pkg);

  const completed = await service.completeUpload({
    ownerId: "owner-1",
    sessionId: created.value.sessionId,
    input: {
      uploadedAssets: [
        ...(await makeUploadedAssets(pkg, { thumbnailBytes })),
        {
          kind: "indexes",
          sha256: await sha256Hex("indexes"),
          sizeBytes: 10,
        },
      ],
    },
  });
  assert.equal(completed.ok, true);

  const job = await processNextRecordingValidationJob({ metadata, objectStorage });
  assert.equal(job.ok, true);
  if (!job.ok) return;
  assert.equal(job.recording.status, "ready");

  const assets = await metadata.listAssets(created.value.recordingId);
  const thumbnailAsset = assets.find((asset) => asset.kind === "thumbnail");
  const indexesAsset = assets.find((asset) => asset.kind === "indexes");
  const eventsAsset = assets.find((asset) => asset.kind === "events");
  assert.ok(thumbnailAsset);
  assert.ok(indexesAsset);
  assert.ok(eventsAsset);
  assert.equal(thumbnailAsset.validatedAt, null);
  assert.equal(indexesAsset.validatedAt, null);
  assert.notEqual(eventsAsset.validatedAt, null);
});

test("validation worker excludes missing optional assets from total asset size budget", async () => {
  const metadata = createMemoryMetadataRepository();
  const objectStorage = createMemoryObjectStorage();
  const service = createCloudRecordingService({ metadata, objectStorage });

  const thumbnailBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0xff, 0x80, 0x57, 0x45]);
  const pkg = await makePackage();
  const request = await makeCreateSessionRequest(pkg, { thumbnailBytes });
  request.idempotencyKey = "idem-missing-optional-large-total";
  request.assets.push({
    kind: "indexes",
    sha256: await sha256Hex("indexes"),
    sizeBytes: 10,
    mimeType: "application/json",
  });

  const created = await service.createUploadSession({
    ownerId: "owner-1",
    input: request,
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const requiredTargets = created.value.uploadTargets.filter(
    (target) => target.kind !== "thumbnail" && target.kind !== "indexes",
  );
  await uploadPackageAssets(objectStorage, requiredTargets, pkg);

  const completed = await service.completeUpload({
    ownerId: "owner-1",
    sessionId: created.value.sessionId,
    input: {
      uploadedAssets: request.assets,
    },
  });
  assert.equal(completed.ok, true);

  const assets = await metadata.listAssets(created.value.recordingId);
  await Promise.all(
    assets.map((asset) => {
      if (asset.kind === "thumbnail") {
        return metadata.updateAsset({
          ...asset,
          sizeBytes: MAX_RECORDING_TOTAL_ASSET_SIZE_BYTES,
        });
      }
      if (asset.kind === "indexes") {
        return metadata.updateAsset({
          ...asset,
          sizeBytes: 1024 * 1024,
        });
      }
      return Promise.resolve();
    }),
  );

  const job = await processNextRecordingValidationJob({ metadata, objectStorage });
  assert.equal(job.ok, true);
  if (!job.ok) return;
  assert.equal(job.recording.status, "ready");
});

test("validation worker does not revive soft_deleted recording to ready", async () => {
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
    input: { uploadedAssets: await makeUploadedAssets(pkg) },
  });
  assert.equal(completed.ok, true);

  // Wrap metadata to inject soft-delete after findNextProcessingRecording
  let findCalled = false;
  const wrappedMetadata = {
    ...metadata,
    async findNextProcessingRecording() {
      const result = await metadata.findNextProcessingRecording();
      if (result && !findCalled) {
        findCalled = true;
        // Simulate race: user deletes the recording while worker is processing
        await metadata.updateRecording({
          ...result,
          status: "soft_deleted",
          deletedAt: new Date().toISOString(),
        });
      }
      return result;
    },
  };

  // Validation worker should NOT revive the recording to "ready"
  const job = await processNextRecordingValidationJob({
    metadata: wrappedMetadata,
    objectStorage,
  });
  assert.equal(job.ok, false);
  assert.ok("recording" in job, "expected recording in job result");
  if ("recording" in job) {
    assert.equal(job.recording.status, "soft_deleted");
  }

  // Verify metadata is still soft_deleted (not overwritten to ready)
  const afterJob = await metadata.getRecording(created.value.recordingId);
  assert.equal(afterJob?.status, "soft_deleted");
});

test("validation worker does not revive soft_deleted recording to failed on validation error", async () => {
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
  // Don't upload assets — validation will fail

  const completed = await service.completeUpload({
    ownerId: "owner-1",
    sessionId: created.value.sessionId,
    input: { uploadedAssets: await makeUploadedAssets(pkg) },
  });
  assert.equal(completed.ok, true);

  // Wrap metadata to inject soft-delete after findNextProcessingRecording
  let findCalled = false;
  const wrappedMetadata = {
    ...metadata,
    async findNextProcessingRecording() {
      const result = await metadata.findNextProcessingRecording();
      if (result && !findCalled) {
        findCalled = true;
        // Simulate race: user deletes the recording while worker is processing
        await metadata.updateRecording({
          ...result,
          status: "soft_deleted",
          deletedAt: new Date().toISOString(),
        });
      }
      return result;
    },
  };

  // Validation worker should NOT revive the recording to "failed"
  const job = await processNextRecordingValidationJob({
    metadata: wrappedMetadata,
    objectStorage,
  });
  assert.equal(job.ok, false);
  assert.ok("recording" in job, "expected recording in job result");
  if ("recording" in job) {
    assert.equal(job.recording.status, "soft_deleted");
  }

  // Verify metadata is still soft_deleted (not overwritten to failed)
  const afterJob = await metadata.getRecording(created.value.recordingId);
  assert.equal(afterJob?.status, "soft_deleted");
});

test("validation worker preserves concurrent rename when writing ready", async () => {
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
    input: { uploadedAssets: await makeUploadedAssets(pkg) },
  });
  assert.equal(completed.ok, true);

  // Wrap metadata to inject rename after findNextProcessingRecording
  let findCalled = false;
  const wrappedMetadata = {
    ...metadata,
    async findNextProcessingRecording() {
      const result = await metadata.findNextProcessingRecording();
      if (result && !findCalled) {
        findCalled = true;
        // Simulate concurrent rename: user renames while worker is processing
        await metadata.updateRecording({
          ...result,
          title: "Renamed During Validation",
          updatedAt: new Date().toISOString(),
        });
      }
      return result;
    },
  };

  const job = await processNextRecordingValidationJob({
    metadata: wrappedMetadata,
    objectStorage,
  });
  assert.equal(job.ok, true);
  assert.ok("recording" in job, "expected recording in job result");
  if ("recording" in job) {
    assert.equal(job.recording.status, "ready");
    // Title should be preserved from the concurrent rename
    assert.equal(job.recording.title, "Renamed During Validation");
  }

  // Verify metadata has the renamed title
  const afterJob = await metadata.getRecording(created.value.recordingId);
  assert.equal(afterJob?.status, "ready");
  assert.equal(afterJob?.title, "Renamed During Validation");
});

test("validation worker preserves concurrent rename when writing failed", async () => {
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
  // Don't upload assets — validation will fail

  const completed = await service.completeUpload({
    ownerId: "owner-1",
    sessionId: created.value.sessionId,
    input: { uploadedAssets: await makeUploadedAssets(pkg) },
  });
  assert.equal(completed.ok, true);

  // Wrap metadata to inject rename after findNextProcessingRecording
  let findCalled = false;
  const wrappedMetadata = {
    ...metadata,
    async findNextProcessingRecording() {
      const result = await metadata.findNextProcessingRecording();
      if (result && !findCalled) {
        findCalled = true;
        // Simulate concurrent rename: user renames while worker is processing
        await metadata.updateRecording({
          ...result,
          title: "Renamed Before Failure",
          updatedAt: new Date().toISOString(),
        });
      }
      return result;
    },
  };

  const job = await processNextRecordingValidationJob({
    metadata: wrappedMetadata,
    objectStorage,
  });
  assert.equal(job.ok, false);
  assert.ok("recording" in job, "expected recording in job result");
  if ("recording" in job) {
    assert.equal(job.recording.status, "failed");
    // Title should be preserved from the concurrent rename
    assert.equal(job.recording.title, "Renamed Before Failure");
  }

  // Verify metadata has the renamed title
  const afterJob = await metadata.getRecording(created.value.recordingId);
  assert.equal(afterJob?.status, "failed");
  assert.equal(afterJob?.title, "Renamed Before Failure");
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
