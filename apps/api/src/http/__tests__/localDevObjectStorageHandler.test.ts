import assert from "node:assert/strict";
import test from "node:test";
import { buildLocalDevObjectUrl, createLocalDevObjectStorage } from "../../cloud/localDevObjectStorage.js";
import { createLocalDevObjectStorageHandler } from "../localDevObjectStorageHandler.js";

const PUBLIC_BASE_URL = "http://localhost";

test("PUT upload stores object readable via getObject and GET download", async () => {
  const storage = createLocalDevObjectStorage({ publicBaseUrl: PUBLIC_BASE_URL });
  const handler = createLocalDevObjectStorageHandler(storage);
  const objectKey = "recordings/rec-1/package/manifest.json";
  const body = new TextEncoder().encode('{"ok":true}');
  const target = storage.createUploadTarget({
    kind: "manifest",
    objectKey,
    mimeType: "application/json",
    maxSizeBytes: body.byteLength,
  });

  const putResponse = await handler(
    new Request(target.url, {
      method: "PUT",
      headers: target.headers,
      body,
    }),
  );
  assert.ok(putResponse);
  assert.equal(putResponse.status, 204);

  const stored = await storage.getObject(objectKey);
  assert.ok(stored);
  assert.deepEqual(stored.body, body);
  assert.equal(stored.contentType, "application/json");
  assert.equal(stored.sizeBytes, body.byteLength);

  const getResponse = await handler(
    new Request(buildLocalDevObjectUrl(PUBLIC_BASE_URL, objectKey), { method: "GET" }),
  );
  assert.ok(getResponse);
  assert.equal(getResponse.status, 200);
  assert.equal(getResponse.headers.get("content-type"), "application/json");
  assert.equal(getResponse.headers.get("content-length"), String(body.byteLength));
  assert.deepEqual(new Uint8Array(await getResponse.arrayBuffer()), body);
});

test("PUT rejects payloads larger than maxSizeBytes", async () => {
  const storage = createLocalDevObjectStorage({ publicBaseUrl: PUBLIC_BASE_URL });
  const handler = createLocalDevObjectStorageHandler(storage);
  const target = storage.createUploadTarget({
    kind: "manifest",
    objectKey: "recordings/rec-1/package/manifest.json",
    mimeType: "application/json",
    maxSizeBytes: 4,
  });
  const body = new TextEncoder().encode("12345");

  const response = await handler(
    new Request(target.url, {
      method: "PUT",
      headers: target.headers,
      body,
    }),
  );
  assert.ok(response);
  assert.equal(response.status, 413);
  const payload = (await response.json()) as { error: { code: string; message: string } };
  assert.equal(payload.error.code, "quota-exceeded");
  assert.match(payload.error.message, /4 bytes/u);
});

test("PUT rejects wrong HTTP method", async () => {
  const storage = createLocalDevObjectStorage({ publicBaseUrl: PUBLIC_BASE_URL });
  const handler = createLocalDevObjectStorageHandler(storage);
  const target = storage.createUploadTarget({
    kind: "manifest",
    objectKey: "recordings/rec-1/package/manifest.json",
    mimeType: "application/json",
    maxSizeBytes: 32,
  });

  const response = await handler(
    new Request(target.url, {
      method: "GET",
      headers: target.headers,
    }),
  );
  assert.ok(response);
  assert.equal(response.status, 405);
});

test("PUT accepts content-type with parameters when base mime matches target", async () => {
  const storage = createLocalDevObjectStorage({ publicBaseUrl: PUBLIC_BASE_URL });
  const handler = createLocalDevObjectStorageHandler(storage);
  const objectKey = "recordings/rec-1/package/manifest.json";
  const body = new TextEncoder().encode("{}");
  const target = storage.createUploadTarget({
    kind: "manifest",
    objectKey,
    mimeType: "application/json",
    maxSizeBytes: body.byteLength,
  });

  const response = await handler(
    new Request(target.url, {
      method: "PUT",
      headers: { "content-type": "application/json; charset=utf-8" },
      body,
    }),
  );
  assert.ok(response);
  assert.equal(response.status, 204);
  assert.ok(await storage.getObject(objectKey));
});

test("PUT accepts upload tokens that need URL path encoding", async () => {
  const storage = createLocalDevObjectStorage({
    publicBaseUrl: PUBLIC_BASE_URL,
    createUploadToken: () => "token/with ?#% chars",
  });
  const handler = createLocalDevObjectStorageHandler(storage);
  const objectKey = "recordings/rec-1/package/manifest.json";
  const body = new TextEncoder().encode("{}");
  const target = storage.createUploadTarget({
    kind: "manifest",
    objectKey,
    mimeType: "application/json",
    maxSizeBytes: body.byteLength,
  });

  assert.match(target.url, /token%2Fwith%20%3F%23%25%20chars/u);

  const response = await handler(
    new Request(target.url, {
      method: "PUT",
      headers: target.headers,
      body,
    }),
  );

  assert.ok(response);
  assert.equal(response.status, 204);
  assert.ok(await storage.getObject(objectKey));
});

test("PUT rejects oversize content-length before reading body", async () => {
  const storage = createLocalDevObjectStorage({ publicBaseUrl: PUBLIC_BASE_URL });
  const handler = createLocalDevObjectStorageHandler(storage);
  const target = storage.createUploadTarget({
    kind: "manifest",
    objectKey: "recordings/rec-1/package/manifest.json",
    mimeType: "application/json",
    maxSizeBytes: 4,
  });
  const body = new TextEncoder().encode("{}");

  const response = await handler(
    new Request(target.url, {
      method: "PUT",
      headers: {
        ...target.headers,
        "content-length": String(body.byteLength + 100),
      },
      body,
    }),
  );
  assert.ok(response);
  assert.equal(response.status, 413);
});

test("PUT rejects missing or mismatched content-type", async () => {
  const storage = createLocalDevObjectStorage({ publicBaseUrl: PUBLIC_BASE_URL });
  const handler = createLocalDevObjectStorageHandler(storage);
  const body = new TextEncoder().encode("{}");
  const missingTypeTarget = storage.createUploadTarget({
    kind: "manifest",
    objectKey: "recordings/rec-1/package/manifest.json",
    mimeType: "application/json",
    maxSizeBytes: 32,
  });
  const wrongTypeTarget = storage.createUploadTarget({
    kind: "manifest",
    objectKey: "recordings/rec-2/package/manifest.json",
    mimeType: "application/json",
    maxSizeBytes: 32,
  });

  const missingType = await handler(
    new Request(missingTypeTarget.url, {
      method: "PUT",
      body,
    }),
  );
  assert.ok(missingType);
  assert.equal(missingType.status, 415);

  const wrongType = await handler(
    new Request(wrongTypeTarget.url, {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body,
    }),
  );
  assert.ok(wrongType);
  assert.equal(wrongType.status, 415);
});

test("concurrent PUT on same upload token allows only one success", async () => {
  const storage = createLocalDevObjectStorage({
    publicBaseUrl: PUBLIC_BASE_URL,
    createUploadToken: () => "token-concurrent",
  });
  const handler = createLocalDevObjectStorageHandler(storage);
  const target = storage.createUploadTarget({
    kind: "manifest",
    objectKey: "recordings/rec-1/package/manifest.json",
    mimeType: "application/json",
    maxSizeBytes: 32,
  });
  const body = new TextEncoder().encode("{}");

  const [first, second] = await Promise.all([
    handler(
      new Request(target.url, {
        method: "PUT",
        headers: target.headers,
        body,
      }),
    ),
    handler(
      new Request(target.url, {
        method: "PUT",
        headers: target.headers,
        body,
      }),
    ),
  ]);

  assert.ok(first);
  assert.ok(second);
  const statuses = [first.status, second.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [204, 409]);
});

test("PUT rejects unknown and consumed upload targets", async () => {
  const storage = createLocalDevObjectStorage({
    publicBaseUrl: PUBLIC_BASE_URL,
    createUploadToken: () => "token-1",
  });
  const handler = createLocalDevObjectStorageHandler(storage);
  const target = storage.createUploadTarget({
    kind: "manifest",
    objectKey: "recordings/rec-1/package/manifest.json",
    mimeType: "application/json",
    maxSizeBytes: 32,
  });
  const body = new TextEncoder().encode("{}");

  const unknown = await handler(
    new Request(`${PUBLIC_BASE_URL}/dev/object-storage/uploads/missing-token`, {
      method: "PUT",
      headers: target.headers,
      body,
    }),
  );
  assert.ok(unknown);
  assert.equal(unknown.status, 404);

  const first = await handler(
    new Request(target.url, {
      method: "PUT",
      headers: target.headers,
      body,
    }),
  );
  assert.ok(first);
  assert.equal(first.status, 204);

  const second = await handler(
    new Request(target.url, {
      method: "PUT",
      headers: target.headers,
      body,
    }),
  );
  assert.ok(second);
  assert.equal(second.status, 409);
});

test("GET rejects malformed object key encoding with 400", async () => {
  const storage = createLocalDevObjectStorage({ publicBaseUrl: PUBLIC_BASE_URL });
  const handler = createLocalDevObjectStorageHandler(storage);

  const response = await handler(
    new Request(`${PUBLIC_BASE_URL}/dev/object-storage/objects/!!!not-base64url`, {
      method: "GET",
    }),
  );
  assert.ok(response);
  assert.equal(response.status, 400);
  const payload = (await response.json()) as { error: { code: string; message: string } };
  assert.equal(payload.error.code, "bad-request");
  assert.match(payload.error.message, /invalid object key encoding/u);
});

test("GET rejects unknown objects and wrong HTTP method", async () => {
  const storage = createLocalDevObjectStorage({ publicBaseUrl: PUBLIC_BASE_URL });
  const handler = createLocalDevObjectStorageHandler(storage);
  const objectKey = "recordings/rec-1/package/manifest.json";

  const missing = await handler(
    new Request(buildLocalDevObjectUrl(PUBLIC_BASE_URL, objectKey), { method: "GET" }),
  );
  assert.ok(missing);
  assert.equal(missing.status, 404);

  const wrongMethod = await handler(
    new Request(buildLocalDevObjectUrl(PUBLIC_BASE_URL, objectKey), { method: "PUT" }),
  );
  assert.ok(wrongMethod);
  assert.equal(wrongMethod.status, 405);
});

test("handler returns null for unrelated routes", async () => {
  const storage = createLocalDevObjectStorage({ publicBaseUrl: PUBLIC_BASE_URL });
  const handler = createLocalDevObjectStorageHandler(storage);
  const response = await handler(new Request("http://localhost/api/recordings/upload-sessions"));
  assert.equal(response, null);
});

test("OPTIONS preflight on upload URL allows cross-origin PUT with content-type", async () => {
  const storage = createLocalDevObjectStorage({ publicBaseUrl: PUBLIC_BASE_URL });
  const handler = createLocalDevObjectStorageHandler(storage);
  const target = storage.createUploadTarget({
    kind: "manifest",
    objectKey: "recordings/rec-1/package/manifest.json",
    mimeType: "application/json",
    maxSizeBytes: 32,
  });
  const webOrigin = "http://localhost:5173";

  const preflight = await handler(
    new Request(target.url, {
      method: "OPTIONS",
      headers: {
        origin: webOrigin,
        "access-control-request-method": "PUT",
        "access-control-request-headers": "content-type",
      },
    }),
  );
  assert.ok(preflight);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), webOrigin);
  assert.match(preflight.headers.get("access-control-allow-methods") ?? "", /PUT/u);
  assert.equal(preflight.headers.get("access-control-allow-headers"), "content-type");

  const body = new TextEncoder().encode("{}");
  const putResponse = await handler(
    new Request(target.url, {
      method: "PUT",
      headers: { ...target.headers, origin: webOrigin },
      body,
    }),
  );
  assert.ok(putResponse);
  assert.equal(putResponse.status, 204);
  assert.equal(putResponse.headers.get("access-control-allow-origin"), webOrigin);
});

test("GET download includes CORS headers for cross-origin reads", async () => {
  const storage = createLocalDevObjectStorage({ publicBaseUrl: PUBLIC_BASE_URL });
  const handler = createLocalDevObjectStorageHandler(storage);
  const objectKey = "recordings/rec-1/package/manifest.json";
  const body = new TextEncoder().encode('{"ok":true}');
  const target = storage.createUploadTarget({
    kind: "manifest",
    objectKey,
    mimeType: "application/json",
    maxSizeBytes: body.byteLength,
  });
  await handler(
    new Request(target.url, {
      method: "PUT",
      headers: target.headers,
      body,
    }),
  );

  const webOrigin = "http://localhost:5173";
  const preflight = await handler(
    new Request(buildLocalDevObjectUrl(PUBLIC_BASE_URL, objectKey), {
      method: "OPTIONS",
      headers: {
        origin: webOrigin,
        "access-control-request-method": "GET",
      },
    }),
  );
  assert.ok(preflight);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), webOrigin);
  assert.match(preflight.headers.get("access-control-allow-methods") ?? "", /GET/u);

  const getResponse = await handler(
    new Request(buildLocalDevObjectUrl(PUBLIC_BASE_URL, objectKey), {
      method: "GET",
      headers: { origin: webOrigin },
    }),
  );
  assert.ok(getResponse);
  assert.equal(getResponse.status, 200);
  assert.equal(getResponse.headers.get("access-control-allow-origin"), webOrigin);
  assert.equal(getResponse.headers.get("content-type"), "application/json");
  assert.equal(getResponse.headers.get("content-length"), String(body.byteLength));
});
