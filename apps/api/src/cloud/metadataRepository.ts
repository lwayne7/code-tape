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
  listRecordingsByOwner(input: {
    ownerId: string;
    statuses?: CloudRecordingRecord["status"][];
  }): Promise<CloudRecordingRecord[]>;
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
  // Atomically updates a recording only if its current status matches expectedStatus.
  // Returns true if the update was applied, false if the status no longer matches
  // (e.g., the recording was concurrently soft-deleted or transitioned to a terminal state).
  // Implementations backed by a relational store should use a conditional UPDATE
  // (e.g., WHERE status = expectedStatus) to make this atomic; in-memory
  // implementations check and swap under a synchronous block.
  updateRecordingIfStatus(
    recording: CloudRecordingRecord,
    expectedStatus: CloudRecordingRecord["status"],
  ): Promise<boolean>;
  updateAsset(asset: CloudRecordingAssetRecord): Promise<void>;
};
