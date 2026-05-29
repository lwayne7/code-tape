import type { CloudApiErrorCode } from "../cloud/types.js";
import {
  decodeObjectKey,
  LOCAL_DEV_OBJECT_STORAGE_OBJECT_PATH_PREFIX,
  LOCAL_DEV_OBJECT_STORAGE_UPLOAD_PATH_PREFIX,
  type LocalDevObjectStorage,
} from "../cloud/localDevObjectStorage.js";

export type LocalDevObjectStorageHandler = (request: Request) => Promise<Response | null>;

const STATUS_BY_ERROR: Record<CloudApiErrorCode, number> = {
  "bad-request": 400,
  unauthorized: 401,
  forbidden: 403,
  "not-found": 404,
  "upload-session-expired": 410,
  "upload-session-conflict": 409,
  "unsupported-schema": 422,
  "invalid-manifest": 422,
  "invalid-event": 422,
  "checksum-mismatch": 422,
  "quota-exceeded": 413,
  "media-type-not-supported": 415,
  "rate-limited": 429,
};

export function createLocalDevObjectStorageHandler(
  storage: LocalDevObjectStorage,
): LocalDevObjectStorageHandler {
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    const uploadMatch = url.pathname.match(
      new RegExp(
        `^${escapeRegExp(LOCAL_DEV_OBJECT_STORAGE_UPLOAD_PATH_PREFIX)}([^/]+)$`,
        "u",
      ),
    );
    if (uploadMatch) {
      const uploadToken = decodePathSegment(uploadMatch[1]!);
      if (!uploadToken) {
        return withLocalDevCors(
          request,
          objectStorageError("bad-request", "invalid upload token encoding"),
          "PUT, OPTIONS",
        );
      }
      return handleUpload(request, storage, uploadToken);
    }

    const objectMatch = url.pathname.match(
      new RegExp(
        `^${escapeRegExp(LOCAL_DEV_OBJECT_STORAGE_OBJECT_PATH_PREFIX)}([^/]+)$`,
        "u",
      ),
    );
    if (objectMatch) {
      return handleDownload(request, storage, objectMatch[1]!);
    }

    if (
      url.pathname.startsWith("/dev/object-storage/") &&
      (url.pathname.startsWith(LOCAL_DEV_OBJECT_STORAGE_UPLOAD_PATH_PREFIX) ||
        url.pathname.startsWith(LOCAL_DEV_OBJECT_STORAGE_OBJECT_PATH_PREFIX))
    ) {
      return objectStorageError("not-found", "route not found");
    }

    return null;
  };
}

async function handleUpload(
  request: Request,
  storage: LocalDevObjectStorage,
  uploadToken: string,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return corsPreflightResponse(request, "PUT, OPTIONS", "content-type");
  }
  if (request.method !== "PUT") {
    return withLocalDevCors(request, methodNotAllowed("upload requires PUT method"), "PUT, OPTIONS");
  }

  const claim = storage.claimPendingUploadTarget(uploadToken);
  if (claim.status === "consumed") {
    return withLocalDevCors(
      request,
      objectStorageError("upload-session-conflict", "upload target already consumed"),
      "PUT, OPTIONS",
    );
  }
  if (claim.status === "not-found") {
    return withLocalDevCors(
      request,
      objectStorageError("not-found", "upload target not found"),
      "PUT, OPTIONS",
    );
  }
  const target = claim.target;

  const contentType = request.headers.get("content-type");
  if (!contentType || !mimeTypesMatch(contentType, target.mimeType)) {
    storage.finalizeConsumedUploadToken(uploadToken);
    return withLocalDevCors(
      request,
      objectStorageError(
        "media-type-not-supported",
        `content-type must be ${target.mimeType}`,
      ),
      "PUT, OPTIONS",
    );
  }

  const bodyResult = await readUploadBody(request, target.maxSizeBytes);
  if (!bodyResult.ok) {
    storage.finalizeConsumedUploadToken(uploadToken);
    return withLocalDevCors(
      request,
      objectStorageError(
        "quota-exceeded",
        `upload exceeds max size of ${target.maxSizeBytes} bytes`,
      ),
      "PUT, OPTIONS",
    );
  }
  const body = bodyResult.body;

  await storage.putObject({
    key: target.objectKey,
    body,
    contentType: target.mimeType,
  });
  storage.finalizeConsumedUploadToken(uploadToken);
  return withLocalDevCors(request, new Response(null, { status: 204 }), "PUT, OPTIONS");
}

async function handleDownload(
  request: Request,
  storage: LocalDevObjectStorage,
  objectKeyEncoded: string,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return corsPreflightResponse(request, "GET, OPTIONS");
  }
  if (request.method !== "GET") {
    return withLocalDevCors(request, methodNotAllowed("download requires GET method"), "GET, OPTIONS");
  }
  const objectKey = decodeObjectKey(objectKeyEncoded);
  if (!objectKey) {
    return withLocalDevCors(
      request,
      objectStorageError("bad-request", "invalid object key encoding"),
      "GET, OPTIONS",
    );
  }

  const stored = await storage.getObject(objectKey);
  if (!stored) {
    return withLocalDevCors(
      request,
      objectStorageError("not-found", "object not found"),
      "GET, OPTIONS",
    );
  }

  return withLocalDevCors(
    request,
    new Response(toArrayBuffer(stored.body), {
      status: 200,
      headers: {
        "content-type": stored.contentType,
        "content-length": String(stored.sizeBytes),
      },
    }),
    "GET, OPTIONS",
  );
}

function mimeTypesMatch(actual: string, expected: string): boolean {
  return mediaTypeBase(actual) === mediaTypeBase(expected);
}

function mediaTypeBase(value: string): string {
  const semicolon = value.indexOf(";");
  const base = semicolon === -1 ? value : value.slice(0, semicolon);
  return base.trim().toLowerCase();
}

async function readUploadBody(
  request: Request,
  maxSizeBytes: number,
): Promise<{ ok: true; body: Uint8Array } | { ok: false }> {
  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxSizeBytes) {
      return { ok: false };
    }
  }

  if (!request.body) {
    return { ok: true, body: new Uint8Array() };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      total += value.byteLength;
      if (total > maxSizeBytes) {
        await reader.cancel();
        return { ok: false };
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    throw new Error("failed to read upload body");
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, body };
}

function methodNotAllowed(message: string): Response {
  return new Response(
    JSON.stringify({
      error: { code: "bad-request", message },
    }),
    {
      status: 405,
      headers: { "content-type": "application/json" },
    },
  );
}

function objectStorageError(code: CloudApiErrorCode, message: string): Response {
  return new Response(
    JSON.stringify({
      error: { code, message },
    }),
    {
      status: STATUS_BY_ERROR[code],
      headers: { "content-type": "application/json" },
    },
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function decodePathSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function corsPreflightResponse(
  request: Request,
  allowedMethods: string,
  allowedHeaders?: string,
): Response {
  const headers = new Headers(buildCorsOriginHeaders(request));
  headers.set("access-control-allow-methods", allowedMethods);
  const requestedHeaders = request.headers.get("access-control-request-headers");
  if (allowedHeaders) {
    headers.set("access-control-allow-headers", allowedHeaders);
  } else if (requestedHeaders) {
    headers.set("access-control-allow-headers", requestedHeaders);
  }
  return new Response(null, { status: 204, headers });
}

function withLocalDevCors(
  request: Request,
  response: Response,
  allowedMethods: string,
): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(buildCorsOriginHeaders(request))) {
    headers.set(key, value);
  }
  headers.set("access-control-allow-methods", allowedMethods);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function buildCorsOriginHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  if (origin) {
    return {
      "access-control-allow-origin": origin,
      vary: "Origin",
    };
  }
  return { "access-control-allow-origin": "*" };
}
