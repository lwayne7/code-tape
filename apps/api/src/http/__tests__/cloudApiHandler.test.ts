import assert from "node:assert/strict";
import test from "node:test";
import { canonicalStringify, sha256Hex } from "@code-tape/recording-schema/hash";
import { RECORDING_SCHEMA_VERSION, type RecordingPackageV1 } from "@code-tape/recording-schema";
import { createCloudRecordingService } from "../../cloud/cloudRecordingService.js";
import { createMemoryMetadataRepository } from "../../cloud/memoryMetadataRepository.js";
import { createMemoryObjectStorage } from "../../cloud/memoryObjectStorage.js";
import { createCloudApiHandler } from "../cloudApiHandler.js";

test("POST /api/recordings/upload-sessions returns upload targets with request id", async () => {
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({
      metadata: createMemoryMetadataRepository(),
      objectStorage: createMemoryObjectStorage(),
    }),
    createRequestId: () => "req-test-1",
  });

  const response = await handler(
    new Request("http://localhost/api/recordings/upload-sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-owner-token": "owner-1",
      },
      body: JSON.stringify(await makeCreateSessionRequest(await makePackage())),
    }),
  );
  const body = (await response.json()) as {
    sessionId: string;
    uploadTargets: Array<{ method: string }>;
  };

  assert.equal(response.status, 201);
  assert.equal(response.headers.get("x-request-id"), "req-test-1");
  assert.ok(body.sessionId);
  assert.equal(body.uploadTargets[0]?.method, "PUT");
});

test("cloud API returns the unified error shape when owner token is missing", async () => {
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({
      metadata: createMemoryMetadataRepository(),
      objectStorage: createMemoryObjectStorage(),
    }),
    createRequestId: () => "req-test-2",
  });

  const response = await handler(
    new Request("http://localhost/api/recordings/upload-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(await makeCreateSessionRequest(await makePackage())),
    }),
  );
  const body = (await response.json()) as {
    error: { code: string; message: string; requestId: string };
  };

  assert.equal(response.status, 401);
  assert.deepEqual(body, {
    error: {
      code: "unauthorized",
      message: "missing owner token",
      requestId: "req-test-2",
    },
  });
});

for (const input of [
  { name: "empty", body: undefined },
  { name: "malformed JSON", body: '{"idempotencyKey":' },
  { name: "non-object JSON", body: JSON.stringify(["not", "an", "object"]) },
] as const) {
  test(`cloud API returns the unified error shape for ${input.name} upload-session bodies`, async () => {
    const handler = createCloudApiHandler({
      service: createCloudRecordingService({
        metadata: createMemoryMetadataRepository(),
        objectStorage: createMemoryObjectStorage(),
      }),
      createRequestId: () => `req-${input.name}`,
    });

    const response = await handler(
      new Request("http://localhost/api/recordings/upload-sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-owner-token": "owner-1",
        },
        body: input.body,
      }),
    );
    const body = (await response.json()) as {
      error: { code: string; message: string; requestId: string };
    };

    assert.equal(response.status, 400);
    assert.deepEqual(body, {
      error: {
        code: "bad-request",
        message: "request body must be a valid JSON object",
        requestId: `req-${input.name}`,
      },
    });
  });
}

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
      title: "Cloud API demo",
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
    idempotencyKey: "idem-http-1",
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
