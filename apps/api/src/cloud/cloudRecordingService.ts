import { RECORDING_SCHEMA_VERSION } from "@code-tape/recording-schema";
import type { MetadataRepository } from "./metadataRepository.js";
import type { ObjectStorage } from "./objectStorage.js";
import type {
  CloudApiError,
  CloudRecordingAssetRecord,
  CloudRecordingRecord,
  CloudResult,
  CompleteUploadSessionRequest,
  CompleteUploadSessionResponse,
  CreateUploadSessionRequest,
  CreateUploadSessionResponse,
  RecordingAssetKind,
  UploadSessionRecord,
  UploadTarget,
} from "./types.js";

const REQUIRED_ASSETS: RecordingAssetKind[] = ["manifest", "meta", "events", "snapshots"];
const SESSION_TTL_MS = 30 * 60 * 1000;

export type CloudRecordingService = {
  createUploadSession(input: {
    ownerId: string;
    input: CreateUploadSessionRequest;
  }): Promise<CloudResult<CreateUploadSessionResponse>>;
  completeUpload(input: {
    ownerId: string;
    sessionId: string;
    input: CompleteUploadSessionRequest;
  }): Promise<CloudResult<CompleteUploadSessionResponse>>;
};

export function createCloudRecordingService(deps: {
  metadata: MetadataRepository;
  objectStorage: ObjectStorage;
  now?: () => Date;
  createId?: (prefix: string) => string;
}): CloudRecordingService {
  const now = deps.now ?? (() => new Date());
  const createId = deps.createId ?? createCounterIdFactory();

  return {
    async createUploadSession({ ownerId, input }) {
      const invalid = validateCreateUploadSessionInput(input);
      if (invalid) return { ok: false, error: invalid };

      const existing = await deps.metadata.findSessionByOwnerAndIdempotencyKey(
        ownerId,
        input.idempotencyKey,
      );
      if (existing) {
        const assets = await deps.metadata.listAssets(existing.recordingId);
        return {
          ok: true,
          value: {
            sessionId: existing.id,
            recordingId: existing.recordingId,
            expiresAt: existing.expiresAt,
            uploadTargets: createUploadTargets(deps.objectStorage, assets),
          },
        };
      }

      const createdAt = now().toISOString();
      const expiresAt = new Date(Date.parse(createdAt) + SESSION_TTL_MS).toISOString();
      const recordingId = createId("rec");
      const sessionId = createId("upl");
      const recording: CloudRecordingRecord = {
        id: recordingId,
        ownerId,
        localPackageId: input.localPackageId,
        title: input.title.trim(),
        schemaVersion: input.schemaVersion,
        status: "uploading",
        visibility: "private",
        createdAt,
        updatedAt: createdAt,
        completedAt: null,
        durationMs: input.durationMs,
        initialLanguage: input.initialLanguage,
        hasAudio: input.hasAudio,
        hasCamera: input.hasCamera,
        totalSizeBytes: input.assets.reduce((sum, asset) => sum + asset.sizeBytes, 0),
        eventCount: null,
        snapshotCount: null,
        failureCode: null,
        failureMessage: null,
      };
      const assets = input.assets.map<CloudRecordingAssetRecord>((asset) => ({
        id: createId("asset"),
        recordingId,
        kind: asset.kind,
        objectKey: objectKeyFor(recordingId, asset.kind),
        sha256: asset.sha256,
        sizeBytes: asset.sizeBytes,
        mimeType: asset.mimeType,
        uploadedAt: null,
        validatedAt: null,
      }));
      const session: UploadSessionRecord = {
        id: sessionId,
        recordingId,
        ownerId,
        status: "open",
        expiresAt,
        idempotencyKey: input.idempotencyKey,
        createdAt,
        completedAt: null,
      };

      await deps.metadata.createUpload({ recording, assets, session });

      return {
        ok: true,
        value: {
          sessionId,
          recordingId,
          expiresAt,
          uploadTargets: createUploadTargets(deps.objectStorage, assets),
        },
      };
    },

    async completeUpload({ ownerId, sessionId, input }) {
      const session = await deps.metadata.getSession(sessionId);
      if (!session) return { ok: false, error: { code: "not-found", message: "upload session not found" } };
      if (session.ownerId !== ownerId) {
        return { ok: false, error: { code: "forbidden", message: "upload session owner mismatch" } };
      }
      if (Date.parse(session.expiresAt) <= now().getTime()) {
        return {
          ok: false,
          error: { code: "upload-session-expired", message: "upload session expired" },
        };
      }
      const assets = await deps.metadata.listAssets(session.recordingId);
      const conflict = findCompleteConflict(assets, input);
      if (conflict) return { ok: false, error: conflict };
      const completedAt = now().toISOString();
      await deps.metadata.markUploadCompleted({
        sessionId,
        completedAt,
        uploadedAssetKinds: input.uploadedAssets.map((asset) => asset.kind),
      });
      return { ok: true, value: { recordingId: session.recordingId, status: "processing" } };
    },
  };
}

function validateCreateUploadSessionInput(input: CreateUploadSessionRequest): CloudApiError | null {
  if (input.schemaVersion !== RECORDING_SCHEMA_VERSION) {
    return {
      code: "unsupported-schema",
      message: `unsupported schemaVersion: ${input.schemaVersion}`,
    };
  }
  const kinds = new Set(input.assets.map((asset) => asset.kind));
  const missing = REQUIRED_ASSETS.filter((kind) => !kinds.has(kind));
  if (missing.length > 0) {
    return {
      code: "invalid-manifest",
      message: `missing required assets: ${missing.join(", ")}`,
    };
  }
  if (input.title.trim().length < 1 || input.title.trim().length > 80) {
    return { code: "invalid-manifest", message: "title must be 1 to 80 characters" };
  }
  return null;
}

function createUploadTargets(
  objectStorage: ObjectStorage,
  assets: CloudRecordingAssetRecord[],
): UploadTarget[] {
  return assets.map((asset) =>
    objectStorage.createUploadTarget({
      kind: asset.kind,
      objectKey: asset.objectKey,
      mimeType: asset.mimeType,
      maxSizeBytes: asset.sizeBytes,
    }),
  );
}

function findCompleteConflict(
  expectedAssets: CloudRecordingAssetRecord[],
  input: CompleteUploadSessionRequest,
): CloudApiError | null {
  const uploadedByKind = new Map(input.uploadedAssets.map((asset) => [asset.kind, asset]));
  for (const expected of expectedAssets) {
    const uploaded = uploadedByKind.get(expected.kind);
    if (!uploaded) {
      return {
        code: "upload-session-conflict",
        message: `missing uploaded asset: ${expected.kind}`,
      };
    }
    if (uploaded.sha256 !== expected.sha256 || uploaded.sizeBytes !== expected.sizeBytes) {
      return {
        code: "upload-session-conflict",
        message: `uploaded asset mismatch: ${expected.kind}`,
      };
    }
  }
  return null;
}

function objectKeyFor(recordingId: string, kind: RecordingAssetKind): string {
  const nameByKind: Record<RecordingAssetKind, string> = {
    manifest: "package/manifest.json",
    meta: "package/meta.json",
    events: "package/events.json",
    snapshots: "package/snapshots.json",
    indexes: "package/indexes.json",
    media: "media/media.webm",
    thumbnail: "thumbnails/poster.webp",
  };
  return `recordings/${recordingId}/${nameByKind[kind]}`;
}

function createCounterIdFactory(): (prefix: string) => string {
  let next = 1;
  return (prefix: string) => `${prefix}_${next++}`;
}
