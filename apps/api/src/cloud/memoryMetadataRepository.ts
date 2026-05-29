import type { CreateUploadWriteResult, MetadataRepository } from "./metadataRepository.js";
import type {
  CloudRecordingAssetRecord,
  CloudRecordingRecord,
  UploadSessionRecord,
} from "./types.js";

export function createMemoryMetadataRepository(): MetadataRepository {
  const recordings = new Map<string, CloudRecordingRecord>();
  const sessions = new Map<string, UploadSessionRecord>();
  const assetsByRecording = new Map<string, CloudRecordingAssetRecord[]>();
  const sessionIdByIdempotencyKey = new Map<string, string>();

  return {
    async findSessionByOwnerAndIdempotencyKey(
      ownerId: string,
      idempotencyKey: string,
    ): Promise<UploadSessionRecord | null> {
      for (const session of sessions.values()) {
        if (session.ownerId === ownerId && session.idempotencyKey === idempotencyKey) {
          return { ...session };
        }
      }
      return null;
    },
    async getSession(sessionId: string): Promise<UploadSessionRecord | null> {
      const session = sessions.get(sessionId);
      return session ? { ...session } : null;
    },
    async getRecording(recordingId: string): Promise<CloudRecordingRecord | null> {
      const recording = recordings.get(recordingId);
      return recording ? { ...recording } : null;
    },
    async listRecordingsByOwner(input: {
      ownerId: string;
      statuses?: CloudRecordingRecord["status"][];
    }): Promise<CloudRecordingRecord[]> {
      const allowedStatuses = input.statuses ? new Set(input.statuses) : null;
      return Array.from(recordings.values())
        .filter((recording) => recording.ownerId === input.ownerId)
        .filter((recording) => !allowedStatuses || allowedStatuses.has(recording.status))
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .map((recording) => ({ ...recording }));
    },
    async listAssets(recordingId: string): Promise<CloudRecordingAssetRecord[]> {
      return (assetsByRecording.get(recordingId) ?? []).map((asset) => ({ ...asset }));
    },
    async createUpload(input: {
      recording: CloudRecordingRecord;
      assets: CloudRecordingAssetRecord[];
      session: UploadSessionRecord;
    }): Promise<CreateUploadWriteResult> {
      const idempotencyKey = sessionKey(input.session.ownerId, input.session.idempotencyKey);
      const existingSessionId = sessionIdByIdempotencyKey.get(idempotencyKey);
      if (existingSessionId) {
        const existingSession = sessions.get(existingSessionId);
        if (existingSession) {
          return {
            status: "idempotency-key-exists",
            existingSession: { ...existingSession },
          };
        }
      }
      recordings.set(input.recording.id, { ...input.recording });
      sessions.set(input.session.id, { ...input.session });
      sessionIdByIdempotencyKey.set(idempotencyKey, input.session.id);
      assetsByRecording.set(
        input.recording.id,
        input.assets.map((asset) => ({ ...asset })),
      );
      return { status: "created" };
    },
    async markUploadCompleted(input: {
      sessionId: string;
      completedAt: string;
      uploadedAssetKinds: string[];
    }): Promise<void> {
      const session = sessions.get(input.sessionId);
      if (!session) return;
      sessions.set(input.sessionId, {
        ...session,
        status: "completed",
        completedAt: input.completedAt,
      });
      const recording = recordings.get(session.recordingId);
      if (recording) {
        recordings.set(recording.id, {
          ...recording,
          status: "processing",
          updatedAt: input.completedAt,
        });
      }
      const assets = assetsByRecording.get(session.recordingId) ?? [];
      assetsByRecording.set(
        session.recordingId,
        assets.map((asset) =>
          input.uploadedAssetKinds.includes(asset.kind)
            ? { ...asset, uploadedAt: input.completedAt }
            : asset,
        ),
      );
    },
    async findNextProcessingRecording(): Promise<CloudRecordingRecord | null> {
      for (const recording of recordings.values()) {
        if (recording.status === "processing") return { ...recording };
      }
      return null;
    },
    async listRecordingsByOwner(
      ownerId: string,
      input: { cursor?: string; limit?: number },
    ): Promise<{ items: CloudRecordingRecord[]; nextCursor: string | null }> {
      const limit = input.limit ?? 20;
      const ownerRecordings: CloudRecordingRecord[] = [];
      for (const recording of recordings.values()) {
        if (recording.ownerId === ownerId && recording.status !== "soft_deleted" && recording.status !== "purging" && recording.status !== "deleted") {
          ownerRecordings.push({ ...recording });
        }
      }
      // 按 createdAt 降序排列
      ownerRecordings.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const cursorIndex = input.cursor
        ? ownerRecordings.findIndex((r) => r.id === input.cursor)
        : 0;
      const startIndex = cursorIndex >= 0 ? cursorIndex + 1 : 0;
      const slice = ownerRecordings.slice(startIndex, startIndex + limit);
      const nextCursor = slice.length === limit && startIndex + limit < ownerRecordings.length
        ? slice[slice.length - 1].id
        : null;
      return { items: slice, nextCursor };
    },
    async updateRecording(recording: CloudRecordingRecord): Promise<void> {
      recordings.set(recording.id, { ...recording });
    },
    async updateAsset(asset: CloudRecordingAssetRecord): Promise<void> {
      const assets = assetsByRecording.get(asset.recordingId) ?? [];
      assetsByRecording.set(
        asset.recordingId,
        assets.map((existing) => (existing.id === asset.id ? { ...asset } : existing)),
      );
    },
  };
}

function sessionKey(ownerId: string, idempotencyKey: string): string {
  return `${ownerId}\0${idempotencyKey}`;
}
