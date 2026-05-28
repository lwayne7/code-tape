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
  {
    name: "missing assets",
    body: JSON.stringify({
      idempotencyKey: "idem-http-1",
      localPackageId: "pkg-1",
      title: "Cloud API demo",
      schemaVersion: RECORDING_SCHEMA_VERSION,
      durationMs: 1000,
      initialLanguage: "javascript",
      hasAudio: false,
      hasCamera: false,
    }),
  },
  {
    name: "non-array assets",
    body: JSON.stringify({
      ...(await makeCreateSessionRequest(await makePackage())),
      assets: "not-assets",
    }),
  },
  {
    name: "invalid asset field types",
    body: JSON.stringify({
      ...(await makeCreateSessionRequest(await makePackage())),
      assets: [{ kind: "manifest", sha256: 123, sizeBytes: "bad", mimeType: null }],
    }),
  },
  {
    name: "unknown asset kind",
    body: await makeCreateSessionBody((request) => ({
      ...request,
      assets: request.assets.map((asset) =>
        asset.kind === "manifest" ? { ...asset, kind: "trace" } : asset,
      ),
    })),
  },
  {
    name: "invalid asset checksum",
    body: await makeCreateSessionBody((request) => ({
      ...request,
      assets: request.assets.map((asset) =>
        asset.kind === "manifest" ? { ...asset, sha256: "sha256-placeholder" } : asset,
      ),
    })),
  },
  {
    name: "invalid asset size",
    body: await makeCreateSessionBody((request) => ({
      ...request,
      assets: request.assets.map((asset) =>
        asset.kind === "manifest" ? { ...asset, sizeBytes: -1 } : asset,
      ),
    })),
  },
  {
    name: "empty asset mime type",
    body: await makeCreateSessionBody((request) => ({
      ...request,
      assets: request.assets.map((asset) =>
        asset.kind === "manifest" ? { ...asset, mimeType: " " } : asset,
      ),
    })),
  },
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

test("cloud API rejects duplicate upload-session asset kinds with the unified error shape", async () => {
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({
      metadata: createMemoryMetadataRepository(),
      objectStorage: createMemoryObjectStorage(),
    }),
    createRequestId: () => "req-duplicate-kind",
  });

  const response = await handler(
    new Request("http://localhost/api/recordings/upload-sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-owner-token": "owner-1",
      },
      body: await makeCreateSessionBody((request) => ({
        ...request,
        assets: [...request.assets, { ...request.assets[0]! }],
      })),
    }),
  );
  const body = (await response.json()) as {
    error: { code: string; message: string; requestId: string };
  };

  assert.equal(response.status, 422);
  assert.deepEqual(body, {
    error: {
      code: "invalid-manifest",
      message: "duplicate asset kind: manifest",
      requestId: "req-duplicate-kind",
    },
  });
});

for (const input of [
  {
    name: "blank idempotency key",
    body: await makeCreateSessionBody((request) => ({ ...request, idempotencyKey: " " })),
    message: "idempotencyKey must be 1 to 128 characters",
  },
  {
    name: "oversized idempotency key",
    body: await makeCreateSessionBody((request) => ({
      ...request,
      idempotencyKey: "i".repeat(129),
    })),
    message: "idempotencyKey must be 1 to 128 characters",
  },
  {
    name: "blank local package id",
    body: await makeCreateSessionBody((request) => ({ ...request, localPackageId: " " })),
    message: "localPackageId must be 1 to 128 characters",
  },
  {
    name: "oversized local package id",
    body: await makeCreateSessionBody((request) => ({
      ...request,
      localPackageId: "p".repeat(129),
    })),
    message: "localPackageId must be 1 to 128 characters",
  },
  {
    name: "negative duration",
    body: await makeCreateSessionBody((request) => ({ ...request, durationMs: -1 })),
    message: "durationMs must be a non-negative safe integer",
  },
  {
    name: "fractional duration",
    body: await makeCreateSessionBody((request) => ({ ...request, durationMs: 1.5 })),
    message: "durationMs must be a non-negative safe integer",
  },
  {
    name: "unsafe duration",
    body: await makeCreateSessionBody((request) => ({
      ...request,
      durationMs: Number.MAX_SAFE_INTEGER + 1,
    })),
    message: "durationMs must be a non-negative safe integer",
  },
  {
    name: "unsupported initial language",
    body: await makeCreateSessionBody((request) => ({ ...request, initialLanguage: "ruby" })),
    message: "initialLanguage must be one of javascript, typescript, python",
  },
] as const) {
  test(`cloud API rejects ${input.name} upload-session scalars with the unified error shape`, async () => {
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

    assert.equal(response.status, 422);
    assert.deepEqual(body, {
      error: {
        code: "invalid-manifest",
        message: input.message,
        requestId: `req-${input.name}`,
      },
    });
  });
}

test("cloud API rejects idempotency key reuse with a different upload-session body", async () => {
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({
      metadata: createMemoryMetadataRepository(),
      objectStorage: createMemoryObjectStorage(),
    }),
    createRequestId: () => "req-idempotency-conflict",
  });
  const request = await makeCreateSessionRequest(await makePackage());
  const first = await handler(
    new Request("http://localhost/api/recordings/upload-sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-owner-token": "owner-1",
      },
      body: JSON.stringify(request),
    }),
  );

  const second = await handler(
    new Request("http://localhost/api/recordings/upload-sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-owner-token": "owner-1",
      },
      body: JSON.stringify({ ...request, localPackageId: "pkg-other" }),
    }),
  );
  const body = (await second.json()) as {
    error: { code: string; message: string; requestId: string };
  };

  assert.equal(first.status, 201);
  assert.equal(second.status, 409);
  assert.deepEqual(body, {
    error: {
      code: "upload-session-conflict",
      message: "idempotency key reused with a different upload request",
      requestId: "req-idempotency-conflict",
    },
  });
});

test("cloud API does not return upload targets after an upload session is completed", async () => {
  const service = createCloudRecordingService({
    metadata: createMemoryMetadataRepository(),
    objectStorage: createMemoryObjectStorage(),
  });
  const handler = createCloudApiHandler({
    service,
    createRequestId: () => "req-completed-idempotency",
  });
  const request = await makeCreateSessionRequest(await makePackage());
  const first = await handler(
    new Request("http://localhost/api/recordings/upload-sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-owner-token": "owner-1",
      },
      body: JSON.stringify(request),
    }),
  );
  const firstBody = (await first.json()) as { sessionId: string };
  const completed = await service.completeUpload({
    ownerId: "owner-1",
    sessionId: firstBody.sessionId,
    input: { uploadedAssets: request.assets },
  });

  const retry = await handler(
    new Request("http://localhost/api/recordings/upload-sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-owner-token": "owner-1",
      },
      body: JSON.stringify(request),
    }),
  );
  const body = (await retry.json()) as {
    error: { code: string; message: string; requestId: string };
  };

  assert.equal(first.status, 201);
  assert.equal(completed.ok, true);
  assert.equal(retry.status, 409);
  assert.deepEqual(body, {
    error: {
      code: "upload-session-conflict",
      message: "upload session is not open",
      requestId: "req-completed-idempotency",
    },
  });
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

async function makeCreateSessionBody(
  mutate: (request: Awaited<ReturnType<typeof makeCreateSessionRequest>>) => unknown,
) {
  return JSON.stringify(mutate(await makeCreateSessionRequest(await makePackage())));
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
