import assert from "node:assert/strict";
import test from "node:test";
import { canonicalStringify, sha256Hex } from "@code-tape/recording-schema/hash";
import { RECORDING_SCHEMA_VERSION, type RecordingPackageV1 } from "@code-tape/recording-schema";
import { createCloudRecordingService } from "../../cloud/cloudRecordingService.js";
import { createMemoryMetadataRepository } from "../../cloud/memoryMetadataRepository.js";
import { createLocalDevObjectStorage } from "../../cloud/localDevObjectStorage.js";
import { createApiHandler } from "../createApiHandler.js";
import { createCloudApiHandler } from "../cloudApiHandler.js";
import { createLocalDevObjectStorageHandler } from "../localDevObjectStorageHandler.js";

const PUBLIC_BASE_URL = "http://localhost";

test("create upload session returns fetchable HTTP upload targets", async () => {
  const objectStorage = createLocalDevObjectStorage({ publicBaseUrl: PUBLIC_BASE_URL });
  const handler = createApiHandler({
    cloud: createCloudApiHandler({
      service: createCloudRecordingService({
        metadata: createMemoryMetadataRepository(),
        objectStorage,
      }),
      createRequestId: () => "req-object-http-1",
    }),
    objectStorage: createLocalDevObjectStorageHandler(objectStorage),
  });

  const createResponse = await handler(
    new Request("http://localhost/api/recordings/upload-sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-owner-token": "owner-1",
      },
      body: JSON.stringify(await makeCreateSessionRequest(await makePackage())),
    }),
  );
  const body = (await createResponse.json()) as {
    recordingId: string;
    uploadTargets: Array<{ kind: string; url: string; headers: Record<string, string> }>;
  };

  assert.equal(createResponse.status, 201);
  const manifestTarget = body.uploadTargets.find((target) => target.kind === "manifest");
  assert.ok(manifestTarget);
  assert.match(manifestTarget.url, /^http:\/\/localhost\/dev\/object-storage\/uploads\//u);

  const manifestBytes = new TextEncoder().encode(
    canonicalStringify((await makePackage()).manifest),
  );
  const putResponse = await handler(
    new Request(manifestTarget.url, {
      method: "PUT",
      headers: manifestTarget.headers,
      body: manifestBytes,
    }),
  );
  assert.equal(putResponse.status, 204);

  const objectKey = `recordings/${body.recordingId}/package/manifest.json`;
  const stored = await objectStorage.getObject(objectKey);
  assert.ok(stored);
  assert.equal(stored.sizeBytes, manifestBytes.byteLength);
  assert.equal(stored.contentType, "application/json");
});

async function makePackage(): Promise<RecordingPackageV1> {
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

async function makeCreateSessionRequest(pkg: RecordingPackageV1) {
  return {
    idempotencyKey: "idem-object-http-1",
    localPackageId: pkg.manifest.packageId,
    title: pkg.meta.title,
    schemaVersion: pkg.schemaVersion,
    durationMs: pkg.meta.durationMs,
    initialLanguage: pkg.meta.initialLanguage,
    hasAudio: false,
    hasCamera: false,
    assets: await Promise.all([
      asset("manifest", pkg.manifest),
      asset("meta", pkg.meta),
      asset("events", pkg.events),
      asset("snapshots", pkg.snapshots),
    ]),
  };
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
