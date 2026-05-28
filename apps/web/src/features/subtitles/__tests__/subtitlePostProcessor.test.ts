import { describe, expect, it, vi } from "vitest";
import {
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

function readPromptPayload(prompt: string): {
  code: string;
  runtimeOutput: string;
} {
  const [, rawPayload] = prompt.split("输入：\n");
  if (!rawPayload) throw new Error("prompt is missing payload");
  return JSON.parse(rawPayload) as { code: string; runtimeOutput: string };
}

describe("createHuggingFaceSubtitlePostProcessor", () => {
  it("builds a browser-local text-generation prompt and parses strict JSON output", async () => {
    const pipeline = vi.fn(async (_prompt: string, _options: unknown) => [
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
      "onnx-community/SmolLM2-135M-Instruct-ONNX-MHA",
      { device: "wasm", dtype: "q4" },
    );
    expect(pipeline).toHaveBeenCalledWith(
      expect.stringContaining("中文内容输出简体中文"),
      expect.objectContaining({ do_sample: false, return_full_text: false }),
    );
    expect(pipeline.mock.calls[0]?.[0]).toContain("Counter.tsx");
    expect(pipeline.mock.calls[0]?.[0]).toContain("use state hook");
    expect(result).toEqual({
      segments: [
        { id: "subtitle-1", text: "useState hook" },
        { id: "subtitle-2", text: "render result" },
      ],
      chapters: [{ title: "问题分析", startMs: 0, endMs: 1_000 }],
    });
  });

  it("uses a larger output budget for 100 subtitle segments", async () => {
    const track = makeTrackWithSegments(100);
    const pipeline = vi.fn(
      async (
        _prompt: string,
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
      expect.any(String),
      expect.objectContaining({ max_new_tokens: expect.any(Number) }),
    );
    expect(pipeline.mock.calls[0]?.[1]?.max_new_tokens).toBeGreaterThan(768);
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
  it("keeps the prompt scoped to subtitle correction and chapter generation", () => {
    const prompt = buildSubtitlePostProcessorPrompt({
      track: makeTrack(),
      context: { glossary: ["TypeScript", "React"] },
    });

    expect(prompt).toContain("只输出 JSON");
    expect(prompt).toContain("中文内容输出简体中文");
    expect(prompt).toContain("英文原句、英文短句和英文自然语言保持英文");
    expect(prompt).toContain("segments");
    expect(prompt).toContain("chapters");
    expect(prompt).toContain("TypeScript");
    expect(prompt).toContain("subtitle-1");
  });

  it("budgets large code and runtime context before building the local LLM prompt", () => {
    const longCode = `const head = true;\n${"a".repeat(7_000)}\nconst tail = true;`;
    const longRuntimeOutput = `first error\n${"b".repeat(3_000)}\nlast error`;
    const prompt = buildSubtitlePostProcessorPrompt({
      track: makeTrack(),
      context: {
        code: longCode,
        runtimeOutput: longRuntimeOutput,
      },
    });
    const payload = readPromptPayload(prompt);

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
});
