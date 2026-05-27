import type { MetadataRepository } from "./metadataRepository.js";
import type {
  CloudRecordingAssetRecord,
  CloudRecordingRecord,
  UploadSessionRecord,
} from "./types.js";

export function createMemoryMetadataRepository(): MetadataRepository {
  const recordings = new Map<string, CloudRecordingRecord>();
  const sessions = new Map<string, UploadSessionRecord>();
  const assetsByRecording = new Map<string, CloudRecordingAssetRecord[]>();

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
    async listAssets(recordingId: string): Promise<CloudRecordingAssetRecord[]> {
      return (assetsByRecording.get(recordingId) ?? []).map((asset) => ({ ...asset }));
    },
    async createUpload(input: {
      recording: CloudRecordingRecord;
      assets: CloudRecordingAssetRecord[];
      session: UploadSessionRecord;
    }): Promise<void> {
      recordings.set(input.recording.id, { ...input.recording });
      sessions.set(input.session.id, { ...input.session });
      assetsByRecording.set(
        input.recording.id,
        input.assets.map((asset) => ({ ...asset })),
      );
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
