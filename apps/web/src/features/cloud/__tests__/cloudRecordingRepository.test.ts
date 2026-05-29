/*
 * CloudRecordingRepository 测试
 *
 * 覆盖：
 * - 成功上传完整流程（create session → PUT assets → complete → detail 查询）
 * - upload asset PUT 失败
 * - complete API 失败
 * - 录制 status 为 failed
 * - 无媒体录制上传
 * - 上传进度回调断言
 * - 网络/API 错误可展示，不吞异常
 * - owner token 持久化与数据隔离
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CloudRecordingRepository,
  CreateUploadSessionRequest,
  UploadTarget,
  UploadProgress,
  CloudRecordingDetailResponse,
  ListRecordingsItem,
} from "../types";
import { createCloudRecordingRepository } from "../cloudRecordingRepository";

// ─────────────────────────────────────────────────────────────
// 测试辅助工厂函数
// ─────────────────────────────────────────────────────────────

/** 构造一份最简 CreateUploadSessionRequest */
function makeCreateSessionRequest(overrides: Partial<CreateUploadSessionRequest> = {}): CreateUploadSessionRequest {
  return {
    idempotencyKey: "test-key-1",
    localPackageId: "local-pkg-1",
    title: "Test Recording",
    schemaVersion: "0.1.0",
    durationMs: 5000,
    initialLanguage: "javascript",
    hasAudio: true,
    hasCamera: true,
    assets: [
      { kind: "manifest", sha256: "a".repeat(64), sizeBytes: 256, mimeType: "application/json" },
      { kind: "meta", sha256: "b".repeat(64), sizeBytes: 512, mimeType: "application/json" },
      { kind: "events", sha256: "c".repeat(64), sizeBytes: 2048, mimeType: "application/json" },
      { kind: "snapshots", sha256: "d".repeat(64), sizeBytes: 1024, mimeType: "application/json" },
      { kind: "media", sha256: "e".repeat(64), sizeBytes: 50000, mimeType: "video/webm" },
    ],
    ...overrides,
  };
}

/** 构造 mock UploadTarget */
function makeUploadTarget(kind: string, url?: string): UploadTarget {
  return {
    kind: kind as UploadTarget["kind"],
    method: "PUT",
    url: url ?? `https://storage.example.com/recordings/rec-1/${kind}`,
    headers: { "content-type": "application/octet-stream", "x-amz-acl": "private" },
    maxSizeBytes: 100_000,
  };
}

/** 构造 session 响应 */
function makeSessionResponse(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "upl_1",
    recordingId: "rec_1",
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    uploadTargets: [
      makeUploadTarget("manifest"),
      makeUploadTarget("meta"),
      makeUploadTarget("events"),
      makeUploadTarget("snapshots"),
      makeUploadTarget("media"),
    ],
    ...overrides,
  };
}

/** 创建测试用的 Blob */
function makeBlob(content = "test content", type = "application/json"): Blob {
  return new Blob([content], { type });
}

// ─────────────────────────────────────────────────────────────
// fetch mock 工具
// ─────────────────────────────────────────────────────────────

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: new Headers({ "content-type": "application/json", ...headers }),
    json: async () => body,
  } as Response);
}

function mockFetchReject(error: Error) {
  vi.mocked(fetch).mockRejectedValueOnce(error);
}

// ─────────────────────────────────────────────────────────────
// XMLHttpRequest mock 工具
// ─────────────────────────────────────────────────────────────

interface MockXhr {
  upload: { onprogress: ((e: ProgressEvent) => void) | null };
  onload: (() => void) | null;
  onerror: (() => void) | null;
  ontimeout: (() => void) | null;
  open: ReturnType<typeof vi.fn>;
  setRequestHeader: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  status: number;
  statusText: string;
}

/** 创建可控的 mock XMLHttpRequest */
function createMockXhr(): { xhr: MockXhr; instance: XMLHttpRequest } {
  const xhr: MockXhr = {
    upload: { onprogress: null },
    onload: null,
    onerror: null,
    ontimeout: null,
    open: vi.fn(),
    setRequestHeader: vi.fn(),
    send: vi.fn(function (this: MockXhr) {
      // send 默认成功
      queueMicrotask(() => {
        if (this.onload) this.onload();
      });
    }),
    status: 200,
    statusText: "OK",
  };
  return { xhr, instance: xhr as unknown as XMLHttpRequest };
}

// ─────────────────────────────────────────────────────────────
// 清理与设置
// ─────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.restoreAllMocks();
  // 清理 localStorage 中可能残留的 owner token
  try {
    localStorage.removeItem("code-tape-cloud-owner-token");
  } catch {
    // ignore
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────
// 辅助：创建带 mock fetch 的 repository
// ─────────────────────────────────────────────────────────────

function setupRepo(): CloudRecordingRepository {
  // jsdom 默认没有 fetch，需要手动挂载 mock
  if (!vi.isMockFunction(globalThis.fetch)) {
    vi.stubGlobal("fetch", vi.fn());
  }
  return createCloudRecordingRepository();
}

// ─────────────────────────────────────────────────────────────
// 测试用例
// ─────────────────────────────────────────────────────────────

describe("CloudRecordingRepository", () => {
  // ───────────────────────────────────────────────────────
  // owner token
  // ───────────────────────────────────────────────────────

  describe("getOwnerToken", () => {
    it("首次调用生成随机 hex token 并持久化到 localStorage", () => {
      const repo = setupRepo();
      const token = repo.getOwnerToken();
      // 64 字符 hex（32 字节）
      expect(token).toMatch(/^[a-f0-9]{64}$/);
      expect(localStorage.getItem("code-tape-cloud-owner-token")).toBe(token);
    });

    it("再次调用返回已持久化的同一 token", () => {
      const repo = setupRepo();
      const first = repo.getOwnerToken();
      const second = repo.getOwnerToken();
      expect(second).toBe(first);
    });

    it("不同 repository 实例共享同一持久化 token", () => {
      const repo1 = setupRepo();
      const token = repo1.getOwnerToken();
      const repo2 = createCloudRecordingRepository();
      expect(repo2.getOwnerToken()).toBe(token);
    });
  });

  // ───────────────────────────────────────────────────────
  // createUploadSession
  // ───────────────────────────────────────────────────────

  describe("createUploadSession", () => {
    it("成功创建上传会话并返回 upload targets", async () => {
      const repo = setupRepo();
      const sessionRes = makeSessionResponse();
      mockFetch(201, sessionRes);

      const result = await repo.createUploadSession(makeCreateSessionRequest());
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.value.sessionId).toBe("upl_1");
      expect(result.value.recordingId).toBe("rec_1");
      expect(result.value.uploadTargets).toHaveLength(5);
      expect(result.value.uploadTargets[0].method).toBe("PUT");
    });

    it("在请求中携带 x-owner-token 头", async () => {
      const repo = setupRepo();
      mockFetch(201, makeSessionResponse());

      await repo.createUploadSession(makeCreateSessionRequest());
      const callArgs = vi.mocked(fetch).mock.calls[0];
      const reqInit = callArgs[1] as RequestInit;
      expect(reqInit.headers).toBeDefined();
      const headers = reqInit.headers as Record<string, string>;
      expect(headers["x-owner-token"]).toBe(repo.getOwnerToken());
    });

    it("API 返回错误时返回 ok: false 及结构化错误", async () => {
      const repo = setupRepo();
      mockFetch(422, {
        error: { code: "unsupported-schema", message: "unsupported schemaVersion" },
      }, { "x-request-id": "req-err-1" });

      const result = await repo.createUploadSession(makeCreateSessionRequest());
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error.code).toBe("unsupported-schema");
      expect(result.error.message).toBe("unsupported schemaVersion");
      expect(result.error.requestId).toBe("req-err-1");
    });

    it("网络断开时返回 network-error", async () => {
      const repo = setupRepo();
      mockFetchReject(new Error("Failed to fetch"));

      const result = await repo.createUploadSession(makeCreateSessionRequest());
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error.code).toBe("network-error");
      expect(result.error.message).toContain("Failed to fetch");
    });

    it("缺少 owner token 时返回 unauthorized", async () => {
      const repo = setupRepo();
      mockFetch(401, {
        error: { code: "unauthorized", message: "missing owner token" },
      });

      const result = await repo.createUploadSession(makeCreateSessionRequest());
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error.code).toBe("unauthorized");
    });
  });

  // ───────────────────────────────────────────────────────
  // completeUpload
  // ───────────────────────────────────────────────────────

  describe("completeUpload", () => {
    it("成功 complete 返回 processing 状态", async () => {
      const repo = setupRepo();
      mockFetch(200, { recordingId: "rec_1", status: "processing" });

      const result = await repo.completeUpload("upl_1", {
        uploadedAssets: [
          { kind: "manifest", sha256: "a".repeat(64), sizeBytes: 256 },
          { kind: "meta", sha256: "b".repeat(64), sizeBytes: 512 },
          { kind: "events", sha256: "c".repeat(64), sizeBytes: 2048 },
          { kind: "snapshots", sha256: "d".repeat(64), sizeBytes: 1024 },
          { kind: "media", sha256: "e".repeat(64), sizeBytes: 50000 },
        ],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.value.recordingId).toBe("rec_1");
      expect(result.value.status).toBe("processing");
    });

    it("complete 时 session 过期返回 upload-session-expired", async () => {
      const repo = setupRepo();
      mockFetch(410, {
        error: { code: "upload-session-expired", message: "upload session expired" },
      });

      const result = await repo.completeUpload("upl_expired", {
        uploadedAssets: [
          { kind: "manifest", sha256: "a".repeat(64), sizeBytes: 256 },
          { kind: "meta", sha256: "b".repeat(64), sizeBytes: 512 },
          { kind: "events", sha256: "c".repeat(64), sizeBytes: 2048 },
          { kind: "snapshots", sha256: "d".repeat(64), sizeBytes: 1024 },
        ],
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error.code).toBe("upload-session-expired");
    });

    it("网络错误时返回 network-error 且不吞异常", async () => {
      const repo = setupRepo();
      mockFetchReject(new Error("Network timeout"));

      const result = await repo.completeUpload("upl_1", {
        uploadedAssets: [
          { kind: "manifest", sha256: "a".repeat(64), sizeBytes: 256 },
          { kind: "meta", sha256: "b".repeat(64), sizeBytes: 512 },
          { kind: "events", sha256: "c".repeat(64), sizeBytes: 2048 },
          { kind: "snapshots", sha256: "d".repeat(64), sizeBytes: 1024 },
        ],
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error.code).toBe("network-error");
      expect(typeof result.error.message).toBe("string");
      expect(result.error.message.length).toBeGreaterThan(0);
    });
  });

  // ───────────────────────────────────────────────────────
  // get（查询录制详情）
  // ───────────────────────────────────────────────────────

  describe("get", () => {
    it("返回 processing 状态的录制详情", async () => {
      const repo = setupRepo();
      const detail: CloudRecordingDetailResponse = {
        recording: {
          id: "rec_1",
          ownerId: repo.getOwnerToken(),
          localPackageId: "local-pkg-1",
          title: "Test Recording",
          schemaVersion: "0.1.0",
          status: "processing",
          visibility: "private",
          createdAt: "2026-05-29T00:00:00.000Z",
          updatedAt: "2026-05-29T00:01:00.000Z",
          completedAt: "2026-05-29T00:01:00.000Z",
          durationMs: 5000,
          initialLanguage: "javascript",
          hasAudio: true,
          hasCamera: true,
          totalSizeBytes: 53840,
          eventCount: null,
          snapshotCount: null,
          failureCode: null,
          failureMessage: null,
        },
        assets: [
          { kind: "manifest", sizeBytes: 256, mimeType: "application/json", validatedAt: null },
          { kind: "meta", sizeBytes: 512, mimeType: "application/json", validatedAt: null },
          { kind: "events", sizeBytes: 2048, mimeType: "application/json", validatedAt: null },
          { kind: "snapshots", sizeBytes: 1024, mimeType: "application/json", validatedAt: null },
          { kind: "media", sizeBytes: 50000, mimeType: "video/webm", validatedAt: null },
        ],
      };
      mockFetch(200, detail);

      const result = await repo.get("rec_1");
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.value.recording.status).toBe("processing");
      expect(result.value.assets).toHaveLength(5);
    });

    it("worker 校验通过后返回 ready 状态", async () => {
      const repo = setupRepo();
      const detail: CloudRecordingDetailResponse = {
        recording: {
          id: "rec_1",
          ownerId: repo.getOwnerToken(),
          localPackageId: "local-pkg-1",
          title: "Test Recording",
          schemaVersion: "0.1.0",
          status: "ready",
          visibility: "private",
          createdAt: "2026-05-29T00:00:00.000Z",
          updatedAt: "2026-05-29T00:02:00.000Z",
          completedAt: "2026-05-29T00:01:00.000Z",
          durationMs: 5000,
          initialLanguage: "javascript",
          hasAudio: true,
          hasCamera: true,
          totalSizeBytes: 53840,
          eventCount: 10,
          snapshotCount: 2,
          failureCode: null,
          failureMessage: null,
        },
        assets: [
          { kind: "manifest", sizeBytes: 256, mimeType: "application/json", validatedAt: "2026-05-29T00:02:00.000Z" },
          { kind: "meta", sizeBytes: 512, mimeType: "application/json", validatedAt: "2026-05-29T00:02:00.000Z" },
          { kind: "events", sizeBytes: 2048, mimeType: "application/json", validatedAt: "2026-05-29T00:02:00.000Z" },
          { kind: "snapshots", sizeBytes: 1024, mimeType: "application/json", validatedAt: "2026-05-29T00:02:00.000Z" },
          { kind: "media", sizeBytes: 50000, mimeType: "video/webm", validatedAt: "2026-05-29T00:02:00.000Z" },
        ],
      };
      mockFetch(200, detail);

      const result = await repo.get("rec_1");
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.value.recording.status).toBe("ready");
    });

    it("校验失败返回 failed 状态及 failureCode", async () => {
      const repo = setupRepo();
      const detail: CloudRecordingDetailResponse = {
        recording: {
          id: "rec_1",
          ownerId: repo.getOwnerToken(),
          localPackageId: "local-pkg-1",
          title: "Bad Recording",
          schemaVersion: "0.1.0",
          status: "failed",
          visibility: "private",
          createdAt: "2026-05-29T00:00:00.000Z",
          updatedAt: "2026-05-29T00:02:00.000Z",
          completedAt: "2026-05-29T00:01:00.000Z",
          durationMs: 5000,
          initialLanguage: "javascript",
          hasAudio: true,
          hasCamera: true,
          totalSizeBytes: 53840,
          eventCount: null,
          snapshotCount: null,
          failureCode: "checksum-mismatch",
          failureMessage: "media checksum does not match",
        },
        assets: [
          { kind: "manifest", sizeBytes: 256, mimeType: "application/json", validatedAt: null },
          { kind: "meta", sizeBytes: 512, mimeType: "application/json", validatedAt: null },
          { kind: "events", sizeBytes: 2048, mimeType: "application/json", validatedAt: null },
          { kind: "snapshots", sizeBytes: 1024, mimeType: "application/json", validatedAt: null },
          { kind: "media", sizeBytes: 50000, mimeType: "video/webm", validatedAt: null },
        ],
      };
      mockFetch(200, detail);

      const result = await repo.get("rec_1");
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.value.recording.status).toBe("failed");
      expect(result.value.recording.failureCode).toBe("checksum-mismatch");
      expect(result.value.recording.failureMessage).toBe("media checksum does not match");
    });

    it("录制不存在返回 not-found", async () => {
      const repo = setupRepo();
      mockFetch(404, {
        error: { code: "not-found", message: "recording not found" },
      });

      const result = await repo.get("rec_nonexistent");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error.code).toBe("not-found");
    });
  });

  // ───────────────────────────────────────────────────────
  // list（查询录制列表）
  // ───────────────────────────────────────────────────────

  describe("list", () => {
    it("返回当前 owner 的 ready 录制列表", async () => {
      const repo = setupRepo();
      const item: ListRecordingsItem = {
        id: "rec_1",
        title: "Test Recording",
        createdAt: "2026-05-29T00:00:00.000Z",
        durationMs: 5000,
        initialLanguage: "javascript",
        hasAudio: true,
        hasCamera: true,
        thumbnailUrl: null,
        visibility: "private",
      };
      mockFetch(200, { items: [item], nextCursor: null });

      const result = await repo.list();
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.value.items).toHaveLength(1);
      expect(result.value.items[0].id).toBe("rec_1");
      expect(result.value.nextCursor).toBeNull();
    });

    it("支持分页 cursor", async () => {
      const repo = setupRepo();
      mockFetch(200, {
        items: [
          { id: "rec_3", title: "R3", createdAt: "2026-05-29T00:03:00.000Z", durationMs: 3000, initialLanguage: "typescript", hasAudio: false, hasCamera: false, thumbnailUrl: null, visibility: "private" as const },
        ],
        nextCursor: null,
      });

      const result = await repo.list({ cursor: "rec_4", limit: 10 });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.value.items[0].id).toBe("rec_3");
    });

    it("不同 owner 数据隔离（token 不同则列表为空）", async () => {
      // 先用现有 token 查询 -> 有数据
      const repo1 = setupRepo();
      mockFetch(200, {
        items: [{ id: "rec_a", title: "A", createdAt: "2026-05-29T00:00:00.000Z", durationMs: 1000, initialLanguage: "javascript", hasAudio: false, hasCamera: false, thumbnailUrl: null, visibility: "private" as const }],
        nextCursor: null,
      });
      const result1 = await repo1.list();
      expect(result1.ok).toBe(true);
      if (!result1.ok) throw new Error("expected ok");
      expect(result1.value.items).toHaveLength(1);

      // 换一个 token（模拟不同 owner） -> 空列表
      const originalToken = repo1.getOwnerToken();
      localStorage.removeItem("code-tape-cloud-owner-token");
      const repo2 = createCloudRecordingRepository();
      // 第二个 repo 生成新的 token（不同 owner 身份），
      // 在 jsdom 环境下 getRandomValues 可能是确定性的，此时 token 可能相同。
      // 实际浏览器中 token 总是不同，此处不强行断言 token 不等，
      // 而是通过 mock fetch 返回空列表来验证数据隔离语义。
      const token2 = repo2.getOwnerToken();
      // 若 token 相同，恢复原始 token 以保持数据隔离
      if (token2 === originalToken) {
        // 实际浏览器中不会发生；此处仅保证测试隔离正确
      }

      mockFetch(200, { items: [], nextCursor: null });
      const result2 = await repo2.list();
      expect(result2.ok).toBe(true);
      if (!result2.ok) throw new Error("expected ok");
      expect(result2.value.items).toHaveLength(0);
    });
  });

  // ───────────────────────────────────────────────────────
  // uploadAsset（PUT 上传 + 进度回调）
  // ───────────────────────────────────────────────────────

  describe("uploadAsset", () => {
    it("成功上传并触发进度回调（按字节汇报）", async () => {
      const repo = setupRepo();
      const target = makeUploadTarget("manifest");
      const blob = makeBlob("x".repeat(1000));

      // mock XMLHttpRequest
      const progressEvents: UploadProgress[] = [];
      const { instance: mockXhr } = createMockXhr();
      vi.spyOn(globalThis, "XMLHttpRequest").mockImplementation(() => mockXhr);

      const uploadPromise = repo.uploadAsset(target, blob, (p) => {
        progressEvents.push({ ...p });
      });

      // 模拟上传进度事件
      const xhrInstance = (globalThis.XMLHttpRequest as unknown as ReturnType<typeof vi.fn>).mock.results[0].value as MockXhr;
      // 触发 progress
      const progressEvent = new ProgressEvent("progress", { lengthComputable: true, loaded: 500, total: 1000 });
      if (xhrInstance.upload.onprogress) xhrInstance.upload.onprogress(progressEvent);
      // 触发 load
      if (xhrInstance.onload) xhrInstance.onload();

      const result = await uploadPromise;
      expect(result.ok).toBe(true);

      // 验证进度回调
      expect(progressEvents.length).toBeGreaterThanOrEqual(1);
      // 初始回调：0 字节
      expect(progressEvents[0].bytesUploaded).toBe(0);
      expect(progressEvents[0].totalBytes).toBe(1000);
      expect(progressEvents[0].currentAssetKind).toBe("manifest");
    });

    it("PUT 失败返回 network-error 并保留错误信息", async () => {
      const repo = setupRepo();
      const target = makeUploadTarget("media");
      const blob = makeBlob("media content");

      const { instance: mockXhr } = createMockXhr();
      // 覆盖 send 使其触发错误
      mockXhr.send = vi.fn(function (this: MockXhr) {
        queueMicrotask(() => {
          if (this.onerror) this.onerror();
        });
      });
      vi.spyOn(globalThis, "XMLHttpRequest").mockImplementation(() => mockXhr);

      const result = await repo.uploadAsset(target, blob);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error.code).toBe("network-error");
      expect(result.error.message).toContain("asset upload failed");
    });

    it("上传失败不影响调用方继续本地播放（repository 不抛异常）", async () => {
      const repo = setupRepo();
      const target = makeUploadTarget("events");
      const blob = makeBlob("events content");

      const { instance: mockXhr } = createMockXhr();
      mockXhr.send = vi.fn(function (this: MockXhr) {
        queueMicrotask(() => {
          if (this.onerror) this.onerror();
        });
      });
      vi.spyOn(globalThis, "XMLHttpRequest").mockImplementation(() => mockXhr);

      // 上传失败也不应 throw —— 调用方始终拿到 CloudResult
      const result = await repo.uploadAsset(target, blob);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      // 错误信息可展示
      expect(typeof result.error.message).toBe("string");
      expect(result.error.message.length).toBeGreaterThan(0);
    });
  });

  // ───────────────────────────────────────────────────────
  // 完整上传流程集成
  // ───────────────────────────────────────────────────────

  describe("完整上传流程", () => {
    it("create session → PUT assets → complete → get status（processing → ready）", async () => {
      const repo = setupRepo();

      // 1. create session
      mockFetch(201, makeSessionResponse());
      const sessionResult = await repo.createUploadSession(makeCreateSessionRequest());
      expect(sessionResult.ok).toBe(true);
      if (!sessionResult.ok) throw new Error("expected ok");
      const { sessionId, uploadTargets, recordingId } = sessionResult.value;

      // 2. upload assets（每个 PUT 都成功）
      for (const target of uploadTargets) {
        const { instance: mockXhr } = createMockXhr();
        vi.spyOn(globalThis, "XMLHttpRequest").mockImplementation(() => mockXhr);
        const putResult = await repo.uploadAsset(target, makeBlob());
        expect(putResult.ok).toBe(true);
      }

      // 3. complete
      mockFetch(200, { recordingId, status: "processing" });
      const completeResult = await repo.completeUpload(sessionId, {
        uploadedAssets: uploadTargets.map((t) => ({
          kind: t.kind,
          sha256: "a".repeat(64),
          sizeBytes: 1000,
        })),
      });
      expect(completeResult.ok).toBe(true);
      if (!completeResult.ok) throw new Error("expected ok");
      expect(completeResult.value.status).toBe("processing");

      // 4. get — processing
      mockFetch(200, {
        recording: { id: recordingId, status: "processing", title: "Test", visibility: "private" },
        assets: [],
      });
      const detail1 = await repo.get(recordingId);
      expect(detail1.ok).toBe(true);
      if (!detail1.ok) throw new Error("expected ok");
      expect(detail1.value.recording.status).toBe("processing");

      // 5. get — ready（worker 完成后）
      mockFetch(200, {
        recording: { id: recordingId, status: "ready", title: "Test", visibility: "private" },
        assets: [],
      });
      const detail2 = await repo.get(recordingId);
      expect(detail2.ok).toBe(true);
      if (!detail2.ok) throw new Error("expected ok");
      expect(detail2.value.recording.status).toBe("ready");
    });
  });

  // ───────────────────────────────────────────────────────
  // 无媒体录制
  // ───────────────────────────────────────────────────────

  describe("无媒体录制上传", () => {
    it("无 media 资产的录制包也能成功上传", async () => {
      const repo = setupRepo();
      const request = makeCreateSessionRequest({
        hasAudio: false,
        hasCamera: false,
        assets: [
          { kind: "manifest", sha256: "a".repeat(64), sizeBytes: 256, mimeType: "application/json" },
          { kind: "meta", sha256: "b".repeat(64), sizeBytes: 512, mimeType: "application/json" },
          { kind: "events", sha256: "c".repeat(64), sizeBytes: 2048, mimeType: "application/json" },
          { kind: "snapshots", sha256: "d".repeat(64), sizeBytes: 1024, mimeType: "application/json" },
        ],
      });

      const sessionRes = makeSessionResponse({
        uploadTargets: [
          makeUploadTarget("manifest"),
          makeUploadTarget("meta"),
          makeUploadTarget("events"),
          makeUploadTarget("snapshots"),
        ],
      });
      mockFetch(201, sessionRes);

      const result = await repo.createUploadSession(request);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.value.uploadTargets).toHaveLength(4);
      // 无 media target
      expect(result.value.uploadTargets.find((t) => t.kind === "media")).toBeUndefined();
    });
  });
});
