import assert from "node:assert/strict";
import test from "node:test";
import { canonicalStringify, sha256Hex } from "@code-tape/recording-schema/hash";
import { RECORDING_SCHEMA_VERSION, type RecordingPackageV1 } from "@code-tape/recording-schema";
import { createCloudRecordingService } from "../../cloud/cloudRecordingService.js";
import { createMemoryMetadataRepository } from "../../cloud/memoryMetadataRepository.js";
import { createMemoryObjectStorage } from "../../cloud/memoryObjectStorage.js";
import { createCloudApiHandler } from "../cloudApiHandler.js";
import type { MetadataRepository } from "../../cloud/metadataRepository.js";
import type { CloudRecordingRecord, RecordingStatus } from "../../cloud/types.js";

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

test("GET /api/recordings returns ready recordings for the current owner sorted by createdAt desc", async () => {
  const metadata = createMemoryMetadataRepository();
  await seedRecording(metadata, { id: "rec-ready-old", ownerId: "owner-1", status: "ready", createdAt: "2026-05-27T00:00:00.000Z" });
  await seedRecording(metadata, { id: "rec-ready-new", ownerId: "owner-1", status: "ready", createdAt: "2026-05-28T00:00:00.000Z", hasAudio: true });
  await seedRecording(metadata, { id: "rec-uploading", ownerId: "owner-1", status: "uploading", createdAt: "2026-05-29T00:00:00.000Z" });
  await seedRecording(metadata, { id: "rec-processing", ownerId: "owner-1", status: "processing" });
  await seedRecording(metadata, { id: "rec-failed", ownerId: "owner-1", status: "failed" });
  await seedRecording(metadata, { id: "rec-soft-deleted", ownerId: "owner-1", status: "soft_deleted" });
  await seedRecording(metadata, { id: "rec-purging", ownerId: "owner-1", status: "purging" });
  await seedRecording(metadata, { id: "rec-deleted", ownerId: "owner-1", status: "deleted" });
  await seedRecording(metadata, { id: "rec-other-owner", ownerId: "owner-2", status: "ready" });
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({
      metadata,
      objectStorage: createMemoryObjectStorage(),
    }),
    createRequestId: () => "req-list",
  });

  const response = await handler(
    new Request("http://localhost/api/recordings", {
      method: "GET",
      headers: { "x-owner-token": "owner-1" },
    }),
  );
  const body = (await response.json()) as Array<Record<string, unknown>>;

  assert.equal(response.status, 200);
  assert.deepEqual(body.map((item) => item.id), ["rec-ready-new", "rec-ready-old"]);
  assert.deepEqual(Object.keys(body[0]!).sort(), [
    "createdAt",
    "durationMs",
    "hasAudio",
    "hasCamera",
    "id",
    "initialLanguage",
    "status",
    "title",
    "updatedAt",
  ]);
  assert.equal(body[0]!.status, "ready");
  assert.equal(body[0]!.hasAudio, true);
});

test("GET /api/recordings returns an empty list for owners with no ready recordings", async () => {
  const metadata = createMemoryMetadataRepository();
  await seedRecording(metadata, { id: "rec-processing", ownerId: "owner-1", status: "processing" });
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({
      metadata,
      objectStorage: createMemoryObjectStorage(),
    }),
    createRequestId: () => "req-empty-list",
  });

  const response = await handler(
    new Request("http://localhost/api/recordings", {
      method: "GET",
      headers: { "x-owner-token": "owner-1" },
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), []);
});

test("GET /api/recordings requires owner token", async () => {
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({
      metadata: createMemoryMetadataRepository(),
      objectStorage: createMemoryObjectStorage(),
    }),
    createRequestId: () => "req-list-owner-token",
  });

  const response = await handler(new Request("http://localhost/api/recordings", { method: "GET" }));
  const body = (await response.json()) as { error: { code: string; message: string; requestId: string } };

  assert.equal(response.status, 401);
  assert.deepEqual(body, {
    error: {
      code: "unauthorized",
      message: "missing owner token",
      requestId: "req-list-owner-token",
    },
  });
});

for (const status of ["uploading", "processing", "ready", "failed"] as const) {
  test(`GET /api/recordings/:recordingId returns ${status} detail for the current owner`, async () => {
    const metadata = createMemoryMetadataRepository();
    await seedRecording(metadata, {
      id: `rec-${status}`,
      ownerId: "owner-1",
      status,
      failureCode: status === "failed" ? "invalid-manifest" : null,
      failureMessage: status === "failed" ? "manifest was invalid" : null,
    });
    const handler = createCloudApiHandler({
      service: createCloudRecordingService({
        metadata,
        objectStorage: createMemoryObjectStorage(),
      }),
      createRequestId: () => `req-detail-${status}`,
    });

    const response = await handler(
      new Request(`http://localhost/api/recordings/rec-${status}`, {
        method: "GET",
        headers: { "x-owner-token": "owner-1" },
      }),
    );
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 200);
    assert.equal(body.id, `rec-${status}`);
    assert.equal(body.status, status);
    assert.equal(body.localPackageId, `local-rec-${status}`);
    if (status === "failed") {
      assert.equal(body.failureCode, "invalid-manifest");
      assert.equal(body.failureMessage, "manifest was invalid");
    }
  });
}

test("GET /api/recordings/:recordingId returns 404 for other owners and hidden statuses", async () => {
  const metadata = createMemoryMetadataRepository();
  await seedRecording(metadata, { id: "rec-owner-2", ownerId: "owner-2", status: "ready" });
  await seedRecording(metadata, { id: "rec-soft-deleted", ownerId: "owner-1", status: "soft_deleted" });
  await seedRecording(metadata, { id: "rec-purging", ownerId: "owner-1", status: "purging" });
  await seedRecording(metadata, { id: "rec-deleted", ownerId: "owner-1", status: "deleted" });
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({
      metadata,
      objectStorage: createMemoryObjectStorage(),
    }),
    createRequestId: () => "req-detail-not-found",
  });

  for (const id of ["rec-owner-2", "rec-soft-deleted", "rec-purging", "rec-deleted", "rec-missing"]) {
    const response = await handler(
      new Request(`http://localhost/api/recordings/${id}`, {
        method: "GET",
        headers: { "x-owner-token": "owner-1" },
      }),
    );
    const body = (await response.json()) as { error: { code: string; message: string } };
    assert.equal(response.status, 404);
    assert.deepEqual(body.error, {
      code: "not-found",
      message: "recording not found",
      requestId: "req-detail-not-found",
    });
  }
});

test("GET /api/recordings/:recordingId requires owner token", async () => {
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({
      metadata: createMemoryMetadataRepository(),
      objectStorage: createMemoryObjectStorage(),
    }),
    createRequestId: () => "req-detail-owner-token",
  });

  const response = await handler(new Request("http://localhost/api/recordings/rec-1", { method: "GET" }));
  const body = (await response.json()) as { error: { code: string; message: string; requestId: string } };

  assert.equal(response.status, 401);
  assert.deepEqual(body, {
    error: {
      code: "unauthorized",
      message: "missing owner token",
      requestId: "req-detail-owner-token",
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

// === POST /api/recordings/upload-sessions/:sessionId/complete 端点测试 ===

test("POST .../complete 首次调用返回 recordingId 与 processing 状态", async () => {
  const service = createCloudRecordingService({
    metadata: createMemoryMetadataRepository(),
    objectStorage: createMemoryObjectStorage(),
  });
  const handler = createCloudApiHandler({
    service,
    createRequestId: () => "req-complete-success",
  });
  const pkg = await makePackage();

  // 先创建上传会话
  const createResp = await handler(
    new Request("http://localhost/api/recordings/upload-sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-owner-token": "owner-1",
      },
      body: JSON.stringify(await makeCreateSessionRequest(pkg)),
    }),
  );
  const createBody = (await createResp.json()) as { sessionId: string; recordingId: string };
  assert.equal(createResp.status, 201);

  // 调用 complete 端点
  const response = await handler(
    new Request(
      `http://localhost/api/recordings/upload-sessions/${createBody.sessionId}/complete`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-owner-token": "owner-1",
        },
        body: await makeCompleteBody(pkg),
      },
    ),
  );
  const body = (await response.json()) as {
    recordingId: string;
    status: string;
  };

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-request-id"), "req-complete-success");
  assert.equal(body.recordingId, createBody.recordingId);
  assert.equal(body.status, "processing");
});

test("POST .../complete 重复调用保持幂等，不退回状态", async () => {
  const service = createCloudRecordingService({
    metadata: createMemoryMetadataRepository(),
    objectStorage: createMemoryObjectStorage(),
  });
  const handler = createCloudApiHandler({
    service,
    createRequestId: () => "req-complete-idempotent",
  });
  const pkg = await makePackage();

  // 创建会话 + 首次 complete
  const createResp = await handler(
    new Request("http://localhost/api/recordings/upload-sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-owner-token": "owner-1",
      },
      body: JSON.stringify(await makeCreateSessionRequest(pkg)),
    }),
  );
  const createBody = (await createResp.json()) as { sessionId: string; recordingId: string };
  const completeUrl = `http://localhost/api/recordings/upload-sessions/${createBody.sessionId}/complete`;
  const completeBody = await makeCompleteBody(pkg);

  const first = await handler(
    new Request(completeUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-owner-token": "owner-1",
      },
      body: completeBody,
    }),
  );
  const firstJson = (await first.json()) as { recordingId: string; status: string };

  const second = await handler(
    new Request(completeUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-owner-token": "owner-1",
      },
      body: completeBody,
    }),
  );
  const secondJson = (await second.json()) as { recordingId: string; status: string };

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(secondJson.recordingId, firstJson.recordingId);
  // 幂等：第二次返回当前 recording 状态（processing），不会回退
  assert.equal(secondJson.status, "processing");
});

test("POST .../complete 缺少 owner token 返回统一的 401 错误结构", async () => {
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({
      metadata: createMemoryMetadataRepository(),
      objectStorage: createMemoryObjectStorage(),
    }),
    createRequestId: () => "req-complete-no-owner",
  });

  const response = await handler(
    new Request(
      "http://localhost/api/recordings/upload-sessions/fake-session-id/complete",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uploadedAssets: [] }),
      },
    ),
  );
  const body = (await response.json()) as {
    error: { code: string; message: string; requestId: string };
  };

  assert.equal(response.status, 401);
  assert.deepEqual(body, {
    error: {
      code: "unauthorized",
      message: "missing owner token",
      requestId: "req-complete-no-owner",
    },
  });
});

// 非法请求体 → 400 测试矩阵
for (const input of [
  { name: "空 body", id: "empty", body: undefined },
  { name: "畸形 JSON", id: "malformed", body: '{"uploadedAssets":' },
  { name: "非对象 JSON", id: "non-object", body: JSON.stringify(["not", "an", "object"]) },
  {
    name: "缺失 uploadedAssets",
    id: "missing-assets",
    body: JSON.stringify({}),
  },
  {
    name: "uploadedAssets 非数组",
    id: "non-array-assets",
    body: JSON.stringify({ uploadedAssets: "not-an-array" }),
  },
  {
    name: "asset 字段类型错误",
    id: "bad-fields",
    body: JSON.stringify({
      uploadedAssets: [{ kind: "manifest", sha256: 123, sizeBytes: "bad" }],
    }),
  },
  {
    name: "顶层额外字段",
    id: "top-extra-key",
    body: JSON.stringify({
      uploadedAssets: [
        { kind: "manifest", sha256: "f".repeat(64), sizeBytes: 100 },
      ],
      extraField: "should-be-rejected",
    }),
  },
  {
    name: "asset 内额外字段",
    id: "asset-extra-key",
    body: JSON.stringify({
      uploadedAssets: [
        {
          kind: "manifest",
          sha256: "f".repeat(64),
          sizeBytes: 100,
          mimeType: "should-be-rejected",
        },
      ],
    }),
  },
] as const) {
  test(`POST .../complete 对 ${input.name} 返回统一的 400 错误结构`, async () => {
    const handler = createCloudApiHandler({
      service: createCloudRecordingService({
        metadata: createMemoryMetadataRepository(),
        objectStorage: createMemoryObjectStorage(),
      }),
      createRequestId: () => `req-complete-${input.id}`,
    });

    const response = await handler(
      new Request(
        "http://localhost/api/recordings/upload-sessions/fake-session-id/complete",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-owner-token": "owner-1",
          },
          body: input.body,
        },
      ),
    );
    const body = (await response.json()) as {
      error: { code: string; message: string; requestId: string };
    };

    assert.equal(response.status, 400);
    assert.deepEqual(body, {
      error: {
        code: "bad-request",
        message: "request body must be a valid JSON object",
        requestId: `req-complete-${input.id}`,
      },
    });
  });
}

test("POST .../complete owner 不匹配返回 403 forbidden", async () => {
  const metadata = createMemoryMetadataRepository();
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({
      metadata,
      objectStorage: createMemoryObjectStorage(),
    }),
    createRequestId: () => "req-complete-forbidden",
  });
  const pkg = await makePackage();

  // 以 owner-1 创建会话
  const createResp = await handler(
    new Request("http://localhost/api/recordings/upload-sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-owner-token": "owner-1",
      },
      body: JSON.stringify(await makeCreateSessionRequest(pkg)),
    }),
  );
  const createBody = (await createResp.json()) as { sessionId: string };

  // 以 owner-2 尝试 complete
  const response = await handler(
    new Request(
      `http://localhost/api/recordings/upload-sessions/${createBody.sessionId}/complete`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-owner-token": "owner-2",
        },
        body: await makeCompleteBody(pkg),
      },
    ),
  );
  const body = (await response.json()) as {
    error: { code: string; message: string; requestId: string };
  };

  assert.equal(response.status, 403);
  assert.deepEqual(body, {
    error: {
      code: "forbidden",
      message: "upload session owner mismatch",
      requestId: "req-complete-forbidden",
    },
  });
});

test("POST .../complete session 不存在返回 404 not-found", async () => {
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({
      metadata: createMemoryMetadataRepository(),
      objectStorage: createMemoryObjectStorage(),
    }),
    createRequestId: () => "req-complete-not-found",
  });

  const response = await handler(
    new Request(
      "http://localhost/api/recordings/upload-sessions/nonexistent-session/complete",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-owner-token": "owner-1",
        },
        body: JSON.stringify({ uploadedAssets: [] }),
      },
    ),
  );
  const body = (await response.json()) as {
    error: { code: string; message: string; requestId: string };
  };

  assert.equal(response.status, 404);
  assert.deepEqual(body, {
    error: {
      code: "not-found",
      message: "upload session not found",
      requestId: "req-complete-not-found",
    },
  });
});

test("POST .../complete session 过期返回 410 upload-session-expired", async () => {
  const metadata = createMemoryMetadataRepository();
  const objectStorage = createMemoryObjectStorage();
  const t1 = Date.parse("2026-05-27T00:00:00.000Z");

  // 在时间点 t1 创建会话（TTL = 30 分钟）
  const createService = createCloudRecordingService({
    metadata,
    objectStorage,
    now: () => new Date(t1),
  });
  const createHandler = createCloudApiHandler({
    service: createService,
    createRequestId: () => "req-expired-create",
  });
  const pkg = await makePackage();
  const createResp = await createHandler(
    new Request("http://localhost/api/recordings/upload-sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-owner-token": "owner-1",
      },
      body: JSON.stringify(await makeCreateSessionRequest(pkg)),
    }),
  );
  const createBody = (await createResp.json()) as { sessionId: string };
  assert.equal(createResp.status, 201);

  // 时间推进 31 分钟，会话已过期
  const t2 = Date.parse("2026-05-27T00:31:00.000Z");
  const expiredService = createCloudRecordingService({
    metadata,
    objectStorage,
    now: () => new Date(t2),
  });
  const expiredHandler = createCloudApiHandler({
    service: expiredService,
    createRequestId: () => "req-complete-expired",
  });

  const response = await expiredHandler(
    new Request(
      `http://localhost/api/recordings/upload-sessions/${createBody.sessionId}/complete`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-owner-token": "owner-1",
        },
        body: await makeCompleteBody(pkg),
      },
    ),
  );
  const body = (await response.json()) as {
    error: { code: string; message: string; requestId: string };
  };

  assert.equal(response.status, 410);
  assert.deepEqual(body, {
    error: {
      code: "upload-session-expired",
      message: "upload session expired",
      requestId: "req-complete-expired",
    },
  });
});

test("POST .../complete session 非 open 且非 completed 返回 409 conflict", async () => {
  const metadata = createMemoryMetadataRepository();
  const handler = createCloudApiHandler({
    service: createCloudRecordingService({
      metadata,
      objectStorage: createMemoryObjectStorage(),
    }),
    createRequestId: () => "req-complete-conflict",
  });
  const pkg = await makePackage();
  const createReq = await makeCreateSessionRequest(pkg);
  const sessionId = "sess-conflict-1";
  const recordingId = "rec-conflict-1";

  // 直接向元数据仓库插入一条 status = "failed" 的 session（非 open 且非 completed）
  await metadata.createUpload({
    recording: {
      id: recordingId,
      ownerId: "owner-1",
      localPackageId: createReq.localPackageId,
      title: createReq.title,
      schemaVersion: createReq.schemaVersion,
      status: "uploading",
      visibility: "private",
      createdAt: "2026-05-27T00:00:00.000Z",
      updatedAt: "2026-05-27T00:00:00.000Z",
      completedAt: null,
      durationMs: createReq.durationMs,
      initialLanguage: createReq.initialLanguage,
      hasAudio: createReq.hasAudio,
      hasCamera: createReq.hasCamera,
      totalSizeBytes: 0,
      eventCount: null,
      snapshotCount: null,
      failureCode: null,
      failureMessage: null,
    },
    assets: createReq.assets.map((asset, i) => ({
      id: `asset-conflict-${i}`,
      recordingId,
      kind: asset.kind,
      objectKey: `key-conflict-${i}`,
      sha256: asset.sha256,
      sizeBytes: asset.sizeBytes,
      mimeType: asset.mimeType,
      uploadedAt: null,
      validatedAt: null,
    })),
    session: {
      id: sessionId,
      recordingId,
      ownerId: "owner-1",
      status: "failed", // 非 open 且非 completed → 触发 409
      expiresAt: "2026-05-28T00:00:00.000Z", // 远未过期
      idempotencyKey: "idem-conflict-1",
      createdAt: "2026-05-27T00:00:00.000Z",
      completedAt: null,
    },
  });

  const response = await handler(
    new Request(
      `http://localhost/api/recordings/upload-sessions/${sessionId}/complete`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-owner-token": "owner-1",
        },
        body: await makeCompleteBody(pkg),
      },
    ),
  );
  const body = (await response.json()) as {
    error: { code: string; message: string; requestId: string };
  };

  assert.equal(response.status, 409);
  assert.deepEqual(body, {
    error: {
      code: "upload-session-conflict",
      message: "upload session is not open",
      requestId: "req-complete-conflict",
    },
  });
});

async function makeCompleteBody(pkg: RecordingPackageV1): Promise<string> {
  const req = await makeCreateSessionRequest(pkg);
  return JSON.stringify({
    uploadedAssets: req.assets.map(({ kind, sha256, sizeBytes }) => ({
      kind,
      sha256,
      sizeBytes,
    })),
  });
}

async function seedRecording(
  metadata: MetadataRepository,
  input: {
    id: string;
    ownerId: string;
    status: RecordingStatus;
    createdAt?: string;
    hasAudio?: boolean;
    hasCamera?: boolean;
    failureCode?: CloudRecordingRecord["failureCode"];
    failureMessage?: string | null;
  },
): Promise<void> {
  const createdAt = input.createdAt ?? "2026-05-27T00:00:00.000Z";
  await metadata.createUpload({
    recording: {
      id: input.id,
      ownerId: input.ownerId,
      localPackageId: `local-${input.id}`,
      title: `Recording ${input.id}`,
      schemaVersion: RECORDING_SCHEMA_VERSION,
      status: input.status,
      visibility: "private",
      createdAt,
      updatedAt: createdAt,
      completedAt: input.status === "ready" ? createdAt : null,
      durationMs: 12_345,
      initialLanguage: "javascript",
      hasAudio: input.hasAudio ?? false,
      hasCamera: input.hasCamera ?? false,
      totalSizeBytes: 1024,
      eventCount: 7,
      snapshotCount: 2,
      failureCode: input.failureCode ?? null,
      failureMessage: input.failureMessage ?? null,
    },
    assets: [],
    session: {
      id: `session-${input.id}`,
      recordingId: input.id,
      ownerId: input.ownerId,
      status: "completed",
      expiresAt: "2026-05-28T00:00:00.000Z",
      idempotencyKey: `idem-${input.id}`,
      createdAt,
      completedAt: createdAt,
    },
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
