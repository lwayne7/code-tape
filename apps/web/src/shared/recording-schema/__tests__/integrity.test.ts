import { describe, expect, it } from "vitest";
import {
  RECORDING_SCHEMA_VERSION,
  sha256Blob,
  verifyRecordingPackageIntegrity,
  type RecordingPackageV1,
} from "@/shared/recording-schema";
import { canonicalStringify, sha256Hex } from "@/shared/util/hash";

async function makePackage(): Promise<RecordingPackageV1> {
  const events: RecordingPackageV1["events"] = [
    {
      id: "e-1",
      seq: 1,
      timestampMs: 100,
      source: "editor",
      track: "main",
      type: "content-change",
      payload: {
        fileId: "main",
        version: 1,
        code: "console.log('hello')",
        contentHash: "hash-1",
        language: "javascript",
        changeReason: "input",
        changeCount: 1,
        flushedBy: "debounce",
      },
    },
  ];
  const snapshots: RecordingPackageV1["snapshots"] = [];
  return {
    schemaVersion: RECORDING_SCHEMA_VERSION,
    manifest: {
      packageId: "pkg-1",
      schemaVersion: RECORDING_SCHEMA_VERSION,
      status: "complete",
      createdAt: "2026-05-24T00:00:00.000Z",
      completedAt: "2026-05-24T00:01:00.000Z",
      checksums: {
        eventsSha256: await sha256Hex(canonicalStringify(events)),
        snapshotsSha256: await sha256Hex(canonicalStringify(snapshots)),
      },
    },
    meta: {
      id: "rec-1",
      title: "demo",
      createdAt: "2026-05-24T00:00:00.000Z",
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

describe("verifyRecordingPackageIntegrity", () => {
  it("accepts matching event and snapshot checksums", async () => {
    const result = await verifyRecordingPackageIntegrity(await makePackage());
    expect(result.ok).toBe(true);
  });

  it("rejects event checksum mismatches", async () => {
    const pkg = await makePackage();
    const event = pkg.events[0];
    if (event.type !== "content-change") throw new Error("test fixture expected content-change");
    pkg.events[0] = {
      ...event,
      payload: { ...event.payload, code: "changed" },
    };

    const result = await verifyRecordingPackageIntegrity(pkg);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toEqual({ code: "checksum-mismatch", target: "events" });
  });

  it("allows missing media blob with a warning", async () => {
    const media = new Blob(["media"], { type: "video/webm" });
    const pkg = await makePackage();
    pkg.media = {
      blobId: "blob-1",
      mimeType: "video/webm",
      durationMs: 1000,
      sizeBytes: media.size,
      timelineOffsetMs: 0,
      hasAudio: true,
      hasCamera: false,
    };
    pkg.manifest.checksums.mediaSha256 = await sha256Blob(media);

    const result = await verifyRecordingPackageIntegrity(pkg, null);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings).toContainEqual({ code: "media-missing", blobId: "blob-1" });
  });

  it("returns the verified media blob for replay", async () => {
    const media = new Blob(["media"], { type: "video/webm" });
    const pkg = await makePackage();
    pkg.media = {
      blobId: "blob-1",
      mimeType: "video/webm",
      durationMs: 1000,
      sizeBytes: media.size,
      timelineOffsetMs: 0,
      hasAudio: true,
      hasCamera: false,
    };
    pkg.manifest.checksums.mediaSha256 = await sha256Blob(media);

    const result = await verifyRecordingPackageIntegrity(pkg, media);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.mediaBlob).toBe(media);
  });

  it("validates checksums before skipping unknown future event types", async () => {
    const pkg = await makePackage();
    pkg.events.push({
      id: "e-future",
      seq: 2,
      timestampMs: 200,
      source: "annotation",
      track: "ui",
      type: "future-event",
      payload: { note: "forward compatible" },
    } as unknown as RecordingPackageV1["events"][number]);
    pkg.manifest.checksums.eventsSha256 = await sha256Hex(canonicalStringify(pkg.events));

    const result = await verifyRecordingPackageIntegrity(pkg);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.package.events).toHaveLength(1);
      expect(result.warnings).toContainEqual({
        code: "unknown-event-skipped",
        seq: 2,
        type: "future-event",
      });
    }
  });

  it("rejects media checksum mismatches when a blob is present", async () => {
    const expected = new Blob(["expected"], { type: "video/webm" });
    const actual = new Blob(["actual"], { type: "video/webm" });
    const pkg = await makePackage();
    pkg.media = {
      blobId: "blob-1",
      mimeType: "video/webm",
      durationMs: 1000,
      sizeBytes: expected.size,
      timelineOffsetMs: 0,
      hasAudio: true,
      hasCamera: false,
    };
    pkg.manifest.checksums.mediaSha256 = await sha256Blob(expected);

    const result = await verifyRecordingPackageIntegrity(pkg, actual);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toEqual({ code: "checksum-mismatch", target: "media" });
  });
});
