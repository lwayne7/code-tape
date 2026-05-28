import { sha256Hex } from "@code-tape/recording-schema/hash";
import {
  sha256Blob,
  verifyRecordingPackageIntegrity,
  type RecordingEvent,
  type RecordingManifest,
  type RecordingMedia,
  type RecordingMeta,
  type RecordingPackageV1,
  type RecordingSnapshot,
} from "@code-tape/recording-schema";
import type { MetadataRepository } from "./metadataRepository.js";
import type { ObjectStorage } from "./objectStorage.js";
import type {
  CloudApiErrorCode,
  CloudRecordingAssetRecord,
  CloudRecordingRecord,
} from "./types.js";

export type ValidationWorkerResult =
  | { ok: true; recording: CloudRecordingRecord }
  | { ok: false; recording: CloudRecordingRecord };

export async function processNextRecordingValidationJob(deps: {
  metadata: MetadataRepository;
  objectStorage: ObjectStorage;
  now?: () => Date;
}): Promise<ValidationWorkerResult | { ok: false; reason: "empty" }> {
  const recording = await deps.metadata.findNextProcessingRecording();
  if (!recording) return { ok: false, reason: "empty" };

  const now = deps.now ?? (() => new Date());
  const assets = await deps.metadata.listAssets(recording.id);
  const assetsByKind = new Map(assets.map((asset) => [asset.kind, asset]));

  const checksumFailure = await findObjectChecksumFailure(deps.objectStorage, assets);
  if (checksumFailure) {
    return failRecording(deps.metadata, recording, now, "checksum-mismatch", checksumFailure);
  }

  let integrity: Awaited<ReturnType<typeof verifyRecordingPackageIntegrity>>;
  let mediaBlob: Blob | null = null;
  try {
    const manifest = await readJsonAsset<RecordingManifest>(
      deps.objectStorage,
      assetsByKind.get("manifest"),
    );
    const meta = await readJsonAsset<RecordingMeta>(deps.objectStorage, assetsByKind.get("meta"));
    const events = await readJsonAsset<RecordingEvent[]>(
      deps.objectStorage,
      assetsByKind.get("events"),
    );
    const snapshots = await readJsonAsset<RecordingSnapshot[]>(
      deps.objectStorage,
      assetsByKind.get("snapshots"),
    );
    const mediaAsset = assetsByKind.get("media");
    const mediaObject = mediaAsset ? await deps.objectStorage.getObject(mediaAsset.objectKey) : null;
    mediaBlob = mediaObject
      ? new Blob([toArrayBuffer(mediaObject.body)], { type: mediaObject.contentType })
      : null;
    const media = mediaBlob
      ? ({
          blobId: mediaAsset?.objectKey ?? "cloud-media",
          mimeType: mediaBlob.type,
          durationMs: recording.durationMs,
          sizeBytes: mediaBlob.size,
          timelineOffsetMs: 0,
          hasAudio: recording.hasAudio,
          hasCamera: recording.hasCamera,
        } satisfies RecordingMedia)
      : null;

    const pkg = {
      schemaVersion: recording.schemaVersion,
      manifest,
      meta,
      events,
      snapshots,
      media,
    } satisfies RecordingPackageV1;
    integrity = await verifyRecordingPackageIntegrity(pkg, mediaBlob);
  } catch (error) {
    return failRecording(deps.metadata, recording, now, "invalid-manifest", errorMessage(error));
  }
  if (!integrity.ok) {
    return failRecording(
      deps.metadata,
      recording,
      now,
      integrity.error.code as CloudApiErrorCode,
      JSON.stringify(integrity.error),
    );
  }

  // P1 Budget Constraints Check
  const MAX_DURATION_MS = 15 * 60 * 1000;
  const MAX_EVENT_COUNT = 20000;
  const MAX_MEDIA_SIZE_BYTES = 200 * 1024 * 1024;
  const MAX_TOTAL_ASSET_SIZE_BYTES = 250 * 1024 * 1024;

  const pkgMeta = integrity.package.meta;
  const pkgEvents = integrity.package.events;

  if (pkgMeta.durationMs > MAX_DURATION_MS) {
    return failRecording(
      deps.metadata,
      recording,
      now,
      "quota-exceeded",
      `duration exceeds budget limit of 15 minutes: ${pkgMeta.durationMs}ms`,
    );
  }
  if (pkgEvents.length > MAX_EVENT_COUNT) {
    return failRecording(
      deps.metadata,
      recording,
      now,
      "quota-exceeded",
      `event count exceeds budget limit of 20000: ${pkgEvents.length}`,
    );
  }
  const mediaAsset = assetsByKind.get("media");
  if (mediaAsset && mediaAsset.sizeBytes > MAX_MEDIA_SIZE_BYTES) {
    return failRecording(
      deps.metadata,
      recording,
      now,
      "quota-exceeded",
      `media size exceeds budget limit of 200MB: ${mediaAsset.sizeBytes} bytes`,
    );
  }
  const totalAssetSize = assets.reduce((sum, asset) => sum + asset.sizeBytes, 0);
  if (totalAssetSize > MAX_TOTAL_ASSET_SIZE_BYTES) {
    return failRecording(
      deps.metadata,
      recording,
      now,
      "quota-exceeded",
      `total asset size exceeds budget limit of 250MB: ${totalAssetSize} bytes`,
    );
  }

  const completedAt = now().toISOString();
  await Promise.all(
    assets.map((asset) =>
      deps.metadata.updateAsset({
        ...asset,
        validatedAt: completedAt,
      }),
    ),
  );

  const hasMedia = !!mediaBlob;
  const ready: CloudRecordingRecord = {
    ...recording,
    status: "ready",
    completedAt,
    updatedAt: completedAt,
    eventCount: integrity.package.events.length,
    snapshotCount: integrity.package.snapshots.length,
    hasAudio: hasMedia ? recording.hasAudio : false,
    hasCamera: hasMedia ? recording.hasCamera : false,
    failureCode: null,
    failureMessage: null,
  };
  await deps.metadata.updateRecording(ready);
  return { ok: true, recording: ready };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function findObjectChecksumFailure(
  objectStorage: ObjectStorage,
  assets: CloudRecordingAssetRecord[],
): Promise<string | null> {
  for (const asset of assets) {
    const object = await objectStorage.getObject(asset.objectKey);
    if (!object) {
      if (isOptionalAssetKind(asset.kind)) {
        continue;
      }
      return `missing object: ${asset.kind}`;
    }
    if (object.sizeBytes !== asset.sizeBytes) return `size mismatch: ${asset.kind}`;
    const sha256 = isBinaryAssetKind(asset.kind)
      ? await sha256Blob(new Blob([toArrayBuffer(object.body)], { type: object.contentType }))
      : await sha256Hex(new TextDecoder().decode(object.body));
    if (sha256 !== asset.sha256) return `checksum mismatch: ${asset.kind}`;
  }
  return null;
}

function isOptionalAssetKind(kind: CloudRecordingAssetRecord["kind"]): boolean {
  return kind === "media" || kind === "thumbnail" || kind === "indexes";
}

function isBinaryAssetKind(kind: CloudRecordingAssetRecord["kind"]): boolean {
  return kind === "media" || kind === "thumbnail";
}

async function readJsonAsset<T>(
  objectStorage: ObjectStorage,
  asset: CloudRecordingAssetRecord | undefined,
): Promise<T> {
  if (!asset) throw new Error("missing required asset");
  const object = await objectStorage.getObject(asset.objectKey);
  if (!object) throw new Error(`missing object: ${asset.kind}`);
  try {
    return JSON.parse(new TextDecoder().decode(object.body)) as T;
  } catch {
    throw new Error(`malformed JSON: ${asset.kind}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "invalid recording package";
}

async function failRecording(
  metadata: MetadataRepository,
  recording: CloudRecordingRecord,
  now: () => Date,
  code: CloudApiErrorCode,
  message: string,
): Promise<ValidationWorkerResult> {
  const failedAt = now().toISOString();
  const failed: CloudRecordingRecord = {
    ...recording,
    status: "failed",
    updatedAt: failedAt,
    failureCode: code,
    failureMessage: message,
  };
  await metadata.updateRecording(failed);
  return { ok: false, recording: failed };
}
