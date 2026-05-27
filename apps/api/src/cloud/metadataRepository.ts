import type {
  CloudRecordingAssetRecord,
  CloudRecordingRecord,
  UploadSessionRecord,
} from "./types.js";

export type MetadataRepository = {
  findSessionByOwnerAndIdempotencyKey(
    ownerId: string,
    idempotencyKey: string,
  ): Promise<UploadSessionRecord | null>;
  getSession(sessionId: string): Promise<UploadSessionRecord | null>;
  getRecording(recordingId: string): Promise<CloudRecordingRecord | null>;
  listAssets(recordingId: string): Promise<CloudRecordingAssetRecord[]>;
  createUpload(input: {
    recording: CloudRecordingRecord;
    assets: CloudRecordingAssetRecord[];
    session: UploadSessionRecord;
  }): Promise<void>;
  markUploadCompleted(input: {
    sessionId: string;
    completedAt: string;
    uploadedAssetKinds: string[];
  }): Promise<void>;
  findNextProcessingRecording(): Promise<CloudRecordingRecord | null>;
  updateRecording(recording: CloudRecordingRecord): Promise<void>;
  updateAsset(asset: CloudRecordingAssetRecord): Promise<void>;
};
