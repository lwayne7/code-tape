import type {
  CloudRecordingAssetRecord,
  CloudRecordingRecord,
  UploadSessionRecord,
} from "./types.js";

export type CreateUploadWriteResult =
  | { status: "created" }
  | { status: "idempotency-key-exists"; existingSession: UploadSessionRecord };

export type MetadataRepository = {
  findSessionByOwnerAndIdempotencyKey(
    ownerId: string,
    idempotencyKey: string,
  ): Promise<UploadSessionRecord | null>;
  getSession(sessionId: string): Promise<UploadSessionRecord | null>;
  getRecording(recordingId: string): Promise<CloudRecordingRecord | null>;
  listAssets(recordingId: string): Promise<CloudRecordingAssetRecord[]>;
  // Atomically writes recording/assets/session with a unique owner + idempotencyKey boundary.
  createUpload(input: {
    recording: CloudRecordingRecord;
    assets: CloudRecordingAssetRecord[];
    session: UploadSessionRecord;
  }): Promise<CreateUploadWriteResult>;
  markUploadCompleted(input: {
    sessionId: string;
    completedAt: string;
    uploadedAssetKinds: string[];
  }): Promise<void>;
  findNextProcessingRecording(): Promise<CloudRecordingRecord | null>;
  updateRecording(recording: CloudRecordingRecord): Promise<void>;
  updateAsset(asset: CloudRecordingAssetRecord): Promise<void>;
};
