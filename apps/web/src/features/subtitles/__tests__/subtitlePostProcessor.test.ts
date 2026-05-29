import { beforeEach, describe, expect, it, vi } from "vitest";

const transformersMock = vi.hoisted(() => ({
  env: {
    useBrowserCache: true,
    useCustomCache: false,
    customCache: null as null | {
      match(cacheKey: string): Promise<Response | undefined>;
      put(cacheKey: string, response: Response): Promise<void>;
    },
    cacheKey: "transformers-cache",
  },
  pipeline: vi.fn(),
}));

vi.mock("@huggingface/transformers", () => transformersMock);

import {
  buildSubtitlePostProcessorMessages,
  buildSubtitlePostProcessorPrompt,
  createHuggingFaceSubtitlePostProcessor,
  extractSubtitleCorrectionResult,
} from "../subtitlePostProcessor";
import type { SubtitleTrack } from "../types";

function makeTrack(): SubtitleTrack {
  return {
    recordingId: "recording-1",
    generatedAt: "2026-05-28T00:00:00.000Z",
    model: "onnx-community/whisper-tiny",
    source: "huggingface-local",
    language: "zh",
    segments: [
      { id: "subtitle-1", startMs: 0, endMs: 1_000, text: "use state hook" },
      { id: "subtitle-2", startMs: 1_000, endMs: 3_000, text: "render result" },
    ],
  };
}

function makeTrackWithSegments(segmentCount: number): SubtitleTrack {
  return {
    ...makeTrack(),
    segments: Array.from({ length: segmentCount }, (_, index) => ({
      id: `subtitle-${index + 1}`,
      startMs: index * 1_000,
      endMs: (index + 1) * 1_000,
      text: `segment ${index + 1}`,
    })),
  };
}

function readUserPayloadFromMessages(messages: unknown): {
  code: string;
  runtimeOutput: string;
} {
  if (!Array.isArray(messages)) throw new Error("messages must be an array");
  const userMessage = messages.find(
    (message): message is { role: string; content: string } =>
      typeof message === "object" &&
      message !== null &&
      "role" in message &&
      "content" in message &&
      message.role === "user" &&
      typeof message.content === "string",
  );
  if (!userMessage) throw new Error("messages are missing a user message");
  const payload = JSON.parse(userMessage.content) as {
    context?: { code?: string; runtimeOutput?: string };
  };
  return {
    code: payload.context?.code ?? "",
    runtimeOutput: payload.context?.runtimeOutput ?? "",
  };
}

describe("createHuggingFaceSubtitlePostProcessor", () => {
  beforeEach(() => {
    transformersMock.env.useBrowserCache = true;
    transformersMock.env.useCustomCache = false;
    transformersMock.env.customCache = null;
    transformersMock.env.cacheKey = "transformers-cache";
    transformersMock.pipeline.mockReset();
  });

  it("builds chat-template messages and parses strict JSON output", async () => {
    const pipeline = vi.fn(async (_prompt: unknown, _options: unknown) => [
      {
        generated_text:
          '```json\n{"segments":[{"id":"subtitle-1","text":"useState hook"},{"id":"subtitle-2","text":"render result"}],"chapters":[{"title":"问题分析","startMs":0,"endMs":1000}]}\n```',
      },
    ]);
    const pipelineFactory = vi.fn(async () => pipeline);
    const postProcessor = createHuggingFaceSubtitlePostProcessor({ pipelineFactory });

    const result = await postProcessor.process({
      track: makeTrack(),
      context: {
        language: "tsx",
        fileName: "Counter.tsx",
        code: "const [count, setCount] = useState(0);",
        runtimeOutput: "ReferenceError: count is not defined",
        glossary: ["useState", "React", "code-tape"],
      },
    });

    expect(pipelineFactory).toHaveBeenCalledWith(
      "text-generation",
      "ceilf6/code-tape-subtitle-postprocessor-onnx",
      { device: "webgpu", dtype: "q4f16" },
    );
    expect(pipeline.mock.calls[0]?.[0]).toEqual([
      {
        role: "system",
        content: expect.stringContaining("只输出 JSON"),
      },
      {
        role: "user",
        content: expect.stringContaining("Counter.tsx"),
      },
    ]);
    expect(pipeline).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ do_sample: false, return_full_text: false }),
    );
    expect(JSON.stringify(pipeline.mock.calls[0]?.[0])).toContain("use state hook");
    expect(JSON.stringify(pipeline.mock.calls[0]?.[0])).not.toContain('"language"');
    expect(result).toEqual({
      segments: [
        { id: "subtitle-1", text: "useState hook" },
        { id: "subtitle-2", text: "render result" },
      ],
      chapters: [{ title: "问题分析", startMs: 0, endMs: 1_000 }],
    });
  });

  it("retries once with a JSON repair prompt when the local LLM omits a JSON object", async () => {
    const pipeline = vi
      .fn()
      .mockResolvedValueOnce([{ generated_text: "Sure, here is the corrected subtitle." }])
      .mockResolvedValueOnce([
        {
          generated_text:
            '{"segments":[{"id":"subtitle-1","text":"useState hook"},{"id":"subtitle-2","text":"render result"}],"chapters":[{"title":"状态设计","startMs":0,"endMs":3000}]}',
        },
      ]);
    const postProcessor = createHuggingFaceSubtitlePostProcessor({
      pipelineFactory: vi.fn(async () => pipeline),
    });

    await expect(postProcessor.process({ track: makeTrack() })).resolves.toEqual({
      segments: [
        { id: "subtitle-1", text: "useState hook" },
        { id: "subtitle-2", text: "render result" },
      ],
      chapters: [{ title: "状态设计", startMs: 0, endMs: 3_000 }],
    });
    expect(pipeline).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(pipeline.mock.calls[1]?.[0])).toContain("Previous output did not contain a parseable JSON");
  });

  it("parses Transformers.js chat message arrays nested inside generated_text", async () => {
    const pipeline = vi.fn(async () => [
      {
        generated_text: [
          { role: "user", content: "input subtitle payload" },
          {
            role: "assistant",
            content:
              '{"segments":[{"id":"subtitle-1","text":"useState hook"}],"chapters":[{"title":"状态设计","startMs":0,"endMs":3000}]}',
          },
        ],
      },
    ]);
    const postProcessor = createHuggingFaceSubtitlePostProcessor({
      pipelineFactory: vi.fn(async () => pipeline),
    });

    await expect(postProcessor.process({ track: makeTrack() })).resolves.toEqual({
      segments: [{ id: "subtitle-1", text: "useState hook" }],
      chapters: [{ title: "状态设计", startMs: 0, endMs: 3_000 }],
    });
  });

  it("drops invented chapters that start after the final input subtitle", async () => {
    const pipeline = vi.fn(async () => [
      {
        generated_text:
          '{"segments":[{"id":"subtitle-1","text":"useState hook"},{"id":"subtitle-2","text":"render result"}],"chapters":[{"title":"状态设计","startMs":0,"endMs":1000},{"title":"模型幻觉章节","startMs":3000,"endMs":4000}]}',
      },
    ]);
    const postProcessor = createHuggingFaceSubtitlePostProcessor({
      pipelineFactory: vi.fn(async () => pipeline),
    });

    await expect(postProcessor.process({ track: makeTrack() })).resolves.toEqual({
      segments: [
        { id: "subtitle-1", text: "useState hook" },
        { id: "subtitle-2", text: "render result" },
      ],
      chapters: [{ title: "状态设计", startMs: 0, endMs: 1_000 }],
    });
  });

  it("drops chapters with replacement-character quantization noise", async () => {
    const pipeline = vi.fn(async () => [
      {
        generated_text:
          '{"segments":[{"id":"subtitle-1","text":"useState hook"},{"id":"subtitle-2","text":"render result"}],"chapters":[{"title":"状态�设计","startMs":0,"endMs":1000},{"title":"渲染结果","startMs":1000,"endMs":3000}]}',
      },
    ]);
    const postProcessor = createHuggingFaceSubtitlePostProcessor({
      pipelineFactory: vi.fn(async () => pipeline),
    });

    await expect(postProcessor.process({ track: makeTrack() })).resolves.toEqual({
      segments: [
        { id: "subtitle-1", text: "useState hook" },
        { id: "subtitle-2", text: "render result" },
      ],
      chapters: [{ title: "渲染结果", startMs: 1_000, endMs: 3_000 }],
    });
  });

  it("falls back to WASM q8 when WebGPU is unavailable", async () => {
    const pipeline = vi.fn(async (_prompt: string, _options: unknown) => [
      {
        generated_text:
          '{"segments":[{"id":"subtitle-1","text":"useState hook"},{"id":"subtitle-2","text":"render result"}],"chapters":[{"title":"状态设计","startMs":0,"endMs":3000}]}',
      },
    ]);
    const unavailableWebGpuError = new Error(
      "no available backend found. ERR: WebGPU is not available in this browser",
    );
    const pipelineFactory = vi
      .fn()
      .mockRejectedValueOnce(unavailableWebGpuError)
      .mockRejectedValueOnce(unavailableWebGpuError)
      .mockResolvedValueOnce(pipeline);
    const postProcessor = createHuggingFaceSubtitlePostProcessor({ pipelineFactory });

    const result = await postProcessor.process({ track: makeTrack() });

    expect(pipelineFactory).toHaveBeenNthCalledWith(
      1,
      "text-generation",
      "ceilf6/code-tape-subtitle-postprocessor-onnx",
      { device: "webgpu", dtype: "q4f16" },
    );
    expect(pipelineFactory).toHaveBeenNthCalledWith(
      2,
      "text-generation",
      "ceilf6/code-tape-subtitle-postprocessor-onnx",
      { device: "webgpu", dtype: "q4" },
    );
    expect(pipelineFactory).toHaveBeenNthCalledWith(
      3,
      "text-generation",
      "ceilf6/code-tape-subtitle-postprocessor-onnx",
      { device: "wasm", dtype: "q8" },
    );
    expect(result.chapters).toEqual([{ title: "状态设计", startMs: 0, endMs: 3_000 }]);
  });

  it("uses the fine-tuned browser model as the default", async () => {
    const pipeline = vi.fn(async (_prompt: string, _options: unknown) => [
      {
        generated_text:
          '{"segments":[{"id":"subtitle-1","text":"useState hook"},{"id":"subtitle-2","text":"render result"}],"chapters":[{"title":"状态设计","startMs":0,"endMs":3000}]}',
      },
    ]);
    const pipelineFactory = vi.fn().mockResolvedValueOnce(pipeline);
    const postProcessor = createHuggingFaceSubtitlePostProcessor({
      pipelineFactory,
    });

    await expect(postProcessor.process({ track: makeTrack() })).resolves.toEqual(
      expect.objectContaining({
        chapters: [{ title: "状态设计", startMs: 0, endMs: 3_000 }],
      }),
    );
    expect(pipelineFactory).toHaveBeenNthCalledWith(
      1,
      "text-generation",
      "ceilf6/code-tape-subtitle-postprocessor-onnx",
      { device: "webgpu", dtype: "q4f16" },
    );
    expect(pipelineFactory).toHaveBeenCalledTimes(1);
  });

  it("uses a quiet custom cache when the browser Cache API rejects large model writes", async () => {
    const loadedPipeline = vi.fn();
    transformersMock.pipeline.mockResolvedValueOnce(loadedPipeline);
    const cache = {
      match: vi.fn(async () => undefined),
      put: vi.fn(async () => {
        throw new DOMException("Unexpected internal error.", "UnknownError");
      }),
    };
    const open = vi.fn(async () => cache);
    vi.stubGlobal("caches", { open });
    const postProcessor = createHuggingFaceSubtitlePostProcessor();

    await postProcessor.warmUp?.();

    expect(transformersMock.env.useCustomCache).toBe(true);
    expect(transformersMock.env.customCache).not.toBeNull();
    await expect(
      transformersMock.env.customCache?.put("model-cache-key", new Response("weights")),
    ).resolves.toBeUndefined();
    expect(open).toHaveBeenCalledWith("transformers-cache");
    expect(cache.put).toHaveBeenCalledWith("model-cache-key", expect.any(Response));
  });

  it("keeps the output budget bounded for long tracks with sparse corrections", async () => {
    const track = makeTrackWithSegments(100);
    const pipeline = vi.fn(
      async (
        _prompt: unknown,
        _options: { max_new_tokens: number; do_sample: boolean; return_full_text: boolean },
      ) => [
        {
          generated_text: JSON.stringify({
            segments: track.segments.map((segment) => ({ id: segment.id, text: segment.text })),
            chapters: [],
          }),
        },
      ],
    );
    const postProcessor = createHuggingFaceSubtitlePostProcessor({
      pipelineFactory: vi.fn(async () => pipeline),
    });

    const result = await postProcessor.process({ track });

    expect(pipeline).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ max_new_tokens: expect.any(Number) }),
    );
    expect(pipeline.mock.calls[0]?.[1]?.max_new_tokens).toBeGreaterThanOrEqual(512);
    expect(pipeline.mock.calls[0]?.[1]?.max_new_tokens).toBeLessThanOrEqual(1_024);
    expect(result.segments).toHaveLength(100);
  });

  it("rejects oversized subtitle tracks before loading the local LLM", async () => {
    const pipelineFactory = vi.fn();
    const postProcessor = createHuggingFaceSubtitlePostProcessor({ pipelineFactory });

    await expect(postProcessor.process({ track: makeTrackWithSegments(121) })).rejects.toThrow(
      /字幕段过多/,
    );
    expect(pipelineFactory).not.toHaveBeenCalled();
  });
});

describe("buildSubtitlePostProcessorPrompt", () => {
  it("builds chat messages that match the fine-tuning conversation shape", () => {
    const messages = buildSubtitlePostProcessorMessages({
      track: makeTrack(),
      context: { glossary: ["TypeScript", "React"] },
    });

    expect(messages).toEqual([
      {
        role: "system",
        content: expect.stringContaining("只输出 JSON"),
      },
      {
        role: "user",
        content: expect.stringContaining("subtitle-1"),
      },
    ]);
  });

  it("keeps the prompt scoped to subtitle correction and chapter generation", () => {
    const prompt = buildSubtitlePostProcessorPrompt({
      track: makeTrack(),
      context: { glossary: ["TypeScript", "React"] },
    });

    expect(prompt).toContain("只输出 JSON");
    expect(prompt).toContain("修正前端术语、变量名、函数名、组件名");
    expect(prompt).not.toContain("简体中文");
    expect(prompt).toContain("只返回需要修改的 segments");
    expect(prompt).toContain("segments");
    expect(prompt).toContain("chapters");
    expect(prompt).toContain("TypeScript");
    expect(prompt).toContain("subtitle-1");
  });

  it("budgets large code and runtime context before building the local LLM messages", () => {
    const longCode = `const head = true;\n${"a".repeat(7_000)}\nconst tail = true;`;
    const longRuntimeOutput = `first error\n${"b".repeat(3_000)}\nlast error`;
    const messages = buildSubtitlePostProcessorMessages({
      track: makeTrack(),
      context: {
        code: longCode,
        runtimeOutput: longRuntimeOutput,
      },
    });
    const payload = readUserPayloadFromMessages(messages);

    expect(payload.code.length).toBeLessThan(longCode.length);
    expect(payload.code).toContain("[truncated");
    expect(payload.code).toContain("const head = true;");
    expect(payload.code).toContain("const tail = true;");
    expect(payload.runtimeOutput.length).toBeLessThan(longRuntimeOutput.length);
    expect(payload.runtimeOutput).toContain("[truncated");
    expect(payload.runtimeOutput).toContain("first error");
    expect(payload.runtimeOutput).toContain("last error");
  });
});

describe("extractSubtitleCorrectionResult", () => {
  it("rejects model output that omits chapters for the complete P1 plus mode", () => {
    expect(() =>
      extractSubtitleCorrectionResult('{"segments":[{"id":"subtitle-1","text":"useState hook"}]}'),
    ).toThrow(/chapters/);
  });

  it("rejects non-JSON model output", () => {
    expect(() => extractSubtitleCorrectionResult("Sure, here is the corrected subtitle.")).toThrow(
      /JSON/,
    );
  });

  it("parses the first complete JSON object when a small local model repeats trailing text", () => {
    expect(
      extractSubtitleCorrectionResult(
        '{"segments":[{"id":"subtitle-1","text":"useState hook"}],"chapters":[{"title":"状态设计","startMs":0,"endMs":1000}]} {"extra":"重复尾巴"}',
      ),
    ).toEqual({
      segments: [{ id: "subtitle-1", text: "useState hook" }],
      chapters: [{ title: "状态设计", startMs: 0, endMs: 1_000 }],
    });
  });
});
