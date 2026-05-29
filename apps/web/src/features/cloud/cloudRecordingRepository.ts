/*
 * CloudRecordingRepository 实现
 *
 * 为后续上传 UI 和云端列表接入提供稳定的前端门面。
 * 不替换 P0 本地 RecordingRepository，作为独立的云端通道存在。
 *
 * 职责：
 * - 创建上传会话（POST /api/recordings/upload-sessions）
 * - 按 upload targets 通过 HTTP PUT 上传各资产（支持进度回调）
 * - 调用 complete API 通知服务端开始校验
 * - 查询录制详情与状态（GET /api/recordings/:id）
 * - 查询当前 owner 的 ready 录制列表（GET /api/recordings）
 * - 管理持久化的 demo owner token
 *
 * 不包含：
 * - 上传按钮或完整 UI
 * - 云端播放页、playback descriptor、CloudPackageLoader
 * - 重命名、删除或分享
 * - 对 P0 本地保存/回放主链路的任何修改
 */

import type {
  CloudRecordingRepository,
  CloudResult,
  CloudRecordingDetail,
  CloudRecordingListItem,
  CompleteUploadSessionRequest,
  CompleteUploadSessionResponse,
  CreateUploadSessionRequest,
  CreateUploadSessionResponse,
  UploadProgress,
  UploadTarget,
  CloudApiError,
} from "./types";

// ─────────────────────────────────────────────────────────────
// 配置常量
// ─────────────────────────────────────────────────────────────

/** localStorage 中存储 owner token 的键名 */
const OWNER_TOKEN_KEY = "code-tape-cloud-owner-token";

/** owner token 随机字符串长度（32 字节 hex = 64 字符） */
const OWNER_TOKEN_BYTES = 32;

/** 默认 API 基础路径（空串表示同源） */
const DEFAULT_API_BASE = "";

// ─────────────────────────────────────────────────────────────
// 工厂函数
// ─────────────────────────────────────────────────────────────

export type CloudRecordingRepositoryOptions = {
  /** API 基础 URL，默认空串（同源）。测试中可传入 mock 地址 */
  apiBase?: string;
};

/**
 * 创建 CloudRecordingRepository 实例
 *
 * owner token 在首次调用 getOwnerToken() 时自动生成并持久化到 localStorage，
 * 该 token 用于标识当前匿名 owner，上传的录制归属于此 owner。
 */
export function createCloudRecordingRepository(
  options: CloudRecordingRepositoryOptions = {},
): CloudRecordingRepository {
  const apiBase = options.apiBase ?? DEFAULT_API_BASE;

  const repo: CloudRecordingRepository = {
    // ── 创建上传会话 ──────────────────────────────────────
    async createUploadSession(input: CreateUploadSessionRequest) {
      const token = repo.getOwnerToken();
      try {
        const response = await fetch(`${apiBase}/api/recordings/upload-sessions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-owner-token": token,
          },
          body: JSON.stringify(input),
        });
        return handleJsonResponse<CreateUploadSessionResponse>(response);
      } catch (err) {
        return { ok: false, error: networkError("create upload session failed", err) };
      }
    },

    // ── 上传单个资产（PUT，支持进度回调） ──────────────────
    async uploadAsset(
      target: UploadTarget,
      blob: Blob,
      onProgress?: (progress: UploadProgress) => void,
    ): Promise<CloudResult<void>> {
      const totalBytes = blob.size;
      // 上报初始进度（0 字节）
      onProgress?.({
        bytesUploaded: 0,
        totalBytes,
        currentAssetKind: target.kind,
      });

      try {
        await putBlobWithProgress(target.url, blob, target.headers, (bytesUploaded) => {
          onProgress?.({
            bytesUploaded,
            totalBytes,
            currentAssetKind: target.kind,
          });
        });
        return { ok: true, value: undefined };
      } catch (err) {
        return {
          ok: false,
          error: networkError("asset upload failed", err),
        };
      }
    },

    // ── 完成上传 ──────────────────────────────────────────
    async completeUpload(
      sessionId: string,
      input: CompleteUploadSessionRequest,
    ): Promise<CloudResult<CompleteUploadSessionResponse>> {
      const token = repo.getOwnerToken();
      try {
        const response = await fetch(
          `${apiBase}/api/recordings/upload-sessions/${encodeURIComponent(sessionId)}/complete`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-owner-token": token,
            },
            body: JSON.stringify(input),
          },
        );
        return handleJsonResponse<CompleteUploadSessionResponse>(response);
      } catch (err) {
        return { ok: false, error: networkError("complete upload failed", err) };
      }
    },

    // ── 查询录制详情 ──────────────────────────────────────
    async get(recordingId: string): Promise<CloudResult<CloudRecordingDetail>> {
      const token = repo.getOwnerToken();
      try {
        const response = await fetch(
          `${apiBase}/api/recordings/${encodeURIComponent(recordingId)}`,
          {
            method: "GET",
            headers: { "x-owner-token": token },
          },
        );
        return handleJsonResponse<CloudRecordingDetail>(response);
      } catch (err) {
        return { ok: false, error: networkError("get recording failed", err) };
      }
    },

    // ── 查询录制列表 ──────────────────────────────────────
    async list(): Promise<CloudResult<CloudRecordingListItem[]>> {
      const token = repo.getOwnerToken();
      try {
        const response = await fetch(
          `${apiBase}/api/recordings`,
          {
            method: "GET",
            headers: { "x-owner-token": token },
          },
        );
        return handleJsonResponse<CloudRecordingListItem[]>(response);
      } catch (err) {
        return { ok: false, error: networkError("list recordings failed", err) };
      }
    },

    // ── owner token 管理 ──────────────────────────────────
    getOwnerToken(): string {
      const existing = readOwnerToken();
      if (existing) return existing;
      const token = generateOwnerToken();
      persistOwnerToken(token);
      return token;
    },
  };

  return repo;
}

// ─────────────────────────────────────────────────────────────
// 内部工具函数
// ─────────────────────────────────────────────────────────────

/**
 * 解析 API JSON 响应，区分成功与错误。
 * 后端错误响应格式：{ error: { code, message, requestId, details? } }
 */
async function handleJsonResponse<T>(response: Response): Promise<CloudResult<T>> {
  if (!response.ok) {
    return parseApiError(response);
  }
  try {
    const value = (await response.json()) as T;
    return { ok: true, value };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "network-error",
        message: `failed to parse response JSON: ${formatError(err)}`,
      },
    };
  }
}

/** 从非 2xx 响应中解析结构化错误 */
async function parseApiError<T>(response: Response): Promise<CloudResult<T>> {
  const requestId = response.headers.get("x-request-id") ?? undefined;
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string; details?: unknown } };
    if (body?.error && typeof body.error.code === "string") {
      return {
        ok: false,
        error: {
          code: body.error.code as CloudApiError["code"],
          message: body.error.message ?? "unknown error",
          requestId,
          details: body.error.details,
        },
      };
    }
  } catch {
    // 响应体不是 JSON，使用 HTTP 状态文本
  }
  return {
    ok: false,
    error: {
      code: "network-error",
      message: `API error ${response.status}: ${response.statusText}`,
      requestId,
    },
  };
}

/** 构造网络错误 */
function networkError(context: string, err: unknown): CloudApiError {
  return {
    code: "network-error",
    message: `${context}: ${formatError(err)}`,
  };
}

/** 格式化异常信息为可展示文本 */
function formatError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === "string") return err;
  return "unknown error";
}

// ─────────────────────────────────────────────────────────────
// 上传进度（XMLHttpRequest）
// ─────────────────────────────────────────────────────────────

/**
 * 使用 XMLHttpRequest 发送 PUT 请求，通过 upload.onprogress 上报字节进度。
 *
 * 选择 XHR 而非 fetch 是因为 fetch 目前不提供上传进度事件，
 * 而 CloudRecordingRepository 的接口需求明确要求支持进度回调。
 */
function putBlobWithProgress(
  url: string,
  blob: Blob,
  headers: Record<string, string>,
  onBytes: (uploaded: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);

    // 设置自定义请求头（由签名 URL 指定）
    for (const [key, value] of Object.entries(headers)) {
      xhr.setRequestHeader(key, value);
    }

    xhr.upload.onprogress = (event: ProgressEvent) => {
      if (event.lengthComputable && event.loaded > 0) {
        onBytes(event.loaded);
      }
    };

    xhr.onload = () => {
      // 2xx 状态码视为成功
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(
          new Error(
            `PUT ${url} returned ${xhr.status}${xhr.statusText ? `: ${xhr.statusText}` : ""}`,
          ),
        );
      }
    };

    xhr.onerror = () => {
      reject(new Error(`PUT ${url} network error`));
    };

    xhr.ontimeout = () => {
      reject(new Error(`PUT ${url} timed out`));
    };

    xhr.send(blob);
  });
}

// ─────────────────────────────────────────────────────────────
// owner token 持久化
// ─────────────────────────────────────────────────────────────

function readOwnerToken(): string | null {
  try {
    if (typeof localStorage !== "undefined") {
      const token = localStorage.getItem(OWNER_TOKEN_KEY);
      if (token && token.length === OWNER_TOKEN_BYTES * 2) {
        return token;
      }
    }
  } catch {
    // localStorage 不可用（如无痕模式或 SSR），返回 null
  }
  return null;
}

function persistOwnerToken(token: string): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(OWNER_TOKEN_KEY, token);
    }
  } catch {
    // localStorage 不可用时静默忽略，token 仅在内存中有效
  }
}

/**
 * 生成安全的随机 owner token（hex 编码）。
 * 在浏览器和 jsdom 环境中使用 crypto.getRandomValues。
 */
function generateOwnerToken(): string {
  if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.getRandomValues) {
    const bytes = new Uint8Array(OWNER_TOKEN_BYTES);
    globalThis.crypto.getRandomValues(bytes);
    return toHex(bytes);
  }
  // 回退：伪随机（仅在不支持 crypto 的环境中触发）
  let hex = "";
  for (let i = 0; i < OWNER_TOKEN_BYTES; i++) {
    hex += Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, "0");
  }
  return hex;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}
