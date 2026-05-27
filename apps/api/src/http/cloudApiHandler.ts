import type { CloudRecordingService } from "../cloud/cloudRecordingService.js";
import type {
  CloudApiError,
  CloudApiErrorCode,
  CreateUploadSessionRequest,
} from "../cloud/types.js";

export type CloudApiHandler = (request: Request) => Promise<Response>;

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

export function createCloudApiHandler(deps: {
  service: CloudRecordingService;
  createRequestId?: () => string;
}): CloudApiHandler {
  const createRequestId = deps.createRequestId ?? (() => crypto.randomUUID());

  return async (request: Request): Promise<Response> => {
    const requestId = createRequestId();
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/api/recordings/upload-sessions") {
      const ownerId = readOwnerToken(request);
      if (!ownerId) {
        return jsonError(
          { code: "unauthorized", message: "missing owner token", requestId },
          requestId,
        );
      }
      const parsed = await readJsonObject(request);
      if (!parsed.ok) return jsonError({ ...parsed.error, requestId }, requestId);
      const input = parsed.value as CreateUploadSessionRequest;
      const result = await deps.service.createUploadSession({ ownerId, input });
      if (!result.ok) return jsonError({ ...result.error, requestId }, requestId);
      return jsonResponse(result.value, 201, requestId);
    }

    return jsonError({ code: "not-found", message: "route not found", requestId }, requestId);
  };
}

async function readJsonObject(
  request: Request,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; error: CloudApiError }> {
  try {
    const value = (await request.json()) as unknown;
    if (!isJsonObject(value)) {
      return { ok: false, error: badRequestError() };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, error: badRequestError() };
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function badRequestError(): CloudApiError {
  return { code: "bad-request", message: "request body must be a valid JSON object" };
}

function readOwnerToken(request: Request): string | null {
  const token = request.headers.get("x-owner-token")?.trim();
  return token ? token : null;
}

function jsonResponse(body: unknown, status: number, requestId: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "x-request-id": requestId,
    },
  });
}

function jsonError(error: CloudApiError, requestId: string): Response {
  return jsonResponse(
    {
      error: {
        code: error.code,
        message: error.message,
        requestId,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    },
    STATUS_BY_ERROR[error.code],
    requestId,
  );
}
