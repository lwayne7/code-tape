import type {
  SubtitleCorrectionResult,
  SubtitlePostProcessor,
  SubtitlePostProcessorContext,
  SubtitleTrack,
} from "./types";

export const DEFAULT_POSTPROCESSOR_MODEL =
  "onnx-community/SmolLM2-135M-Instruct-ONNX-MHA";
const MAX_PROMPT_CODE_CHARS = 6_000;
const MAX_PROMPT_RUNTIME_OUTPUT_CHARS = 2_000;

type TextGenerationPipelineOptions = {
  device: "wasm";
  dtype: "q4";
};

type TextGenerationPipeline = (
  prompt: string,
  options: {
    max_new_tokens: number;
    do_sample: boolean;
    return_full_text: boolean;
  },
) => Promise<unknown>;

type PipelineFactory = (
  task: "text-generation",
  model: string,
  options: TextGenerationPipelineOptions,
) => Promise<TextGenerationPipeline>;

export type HuggingFaceSubtitlePostProcessorOptions = {
  model?: string;
  pipelineFactory?: PipelineFactory;
};

export function createHuggingFaceSubtitlePostProcessor(
  options: HuggingFaceSubtitlePostProcessorOptions = {},
): SubtitlePostProcessor {
  const model = options.model ?? DEFAULT_POSTPROCESSOR_MODEL;
  const pipelineOptions: TextGenerationPipelineOptions = { device: "wasm", dtype: "q4" };
  let pipelinePromise: Promise<TextGenerationPipeline> | null = null;
  const getPipeline = () => {
    if (!pipelinePromise) {
      pipelinePromise = (options.pipelineFactory
        ? options.pipelineFactory("text-generation", model, pipelineOptions)
        : loadDefaultPipeline("text-generation", model, pipelineOptions)
      ).catch((error: unknown) => {
        pipelinePromise = null;
        throw error;
      });
    }
    return pipelinePromise;
  };

  return {
    async warmUp() {
      await getPipeline();
    },
    async process(input) {
      if (input.signal?.aborted) throw new DOMException("字幕纠错已取消", "AbortError");
      const pipeline = await getPipeline();
      if (input.signal?.aborted) throw new DOMException("字幕纠错已取消", "AbortError");
      const output = await pipeline(buildSubtitlePostProcessorPrompt(input), {
        max_new_tokens: 768,
        do_sample: false,
        return_full_text: false,
      });
      if (input.signal?.aborted) throw new DOMException("字幕纠错已取消", "AbortError");
      return extractSubtitleCorrectionResult(readGeneratedText(output));
    },
  };
}

export function buildSubtitlePostProcessorPrompt({
  track,
  context,
}: {
  track: SubtitleTrack;
  context?: SubtitlePostProcessorContext;
}): string {
  const payload = {
    language: context?.language ?? track.language ?? "unknown",
    fileName: context?.fileName ?? null,
    code: budgetPromptText(context?.code ?? "", MAX_PROMPT_CODE_CHARS),
    runtimeOutput: budgetPromptText(
      context?.runtimeOutput ?? "",
      MAX_PROMPT_RUNTIME_OUTPUT_CHARS,
    ),
    glossary: context?.glossary ?? [],
    segments: track.segments.map((segment) => ({
      id: segment.id,
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
    })),
  };

  return [
    "你是 code-tape 的字幕后处理模型。",
    "任务：修正 ASR 字幕里的前端领域术语、变量名、函数名、组件名和中英混合文本，并基于字幕内容生成章节跳转点。",
    "规则：",
    "- 只输出 JSON，不要输出解释、Markdown 或额外文本。",
    "- 中文内容输出简体中文；英文原句、英文短句和英文自然语言保持英文，不要翻译成中文。",
    "- 英文术语、变量名、函数名、组件名保持英文原样。",
    "- segments 只能引用输入中已有的 id，不能改 startMs/endMs。",
    "- chapters 必须按时间递增、互不重叠，标题要短，适合回放导航。",
    "- 无法可靠生成章节时也必须输出 chapters: []。",
    "输出 JSON 结构：",
    '{"segments":[{"id":"subtitle-1","text":"修正后的文本"}],"chapters":[{"title":"问题分析","startMs":0,"endMs":1000}]}',
    "输入：",
    JSON.stringify(payload),
  ].join("\n");
}

function budgetPromptText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const markerFor = (omittedChars: number) => `\n[truncated ${omittedChars} chars]\n`;
  let marker = markerFor(text.length - maxChars);
  let availableChars = maxChars - marker.length;
  if (availableChars <= 0) return text.slice(0, maxChars);

  let headChars = Math.ceil(availableChars / 2);
  let tailChars = Math.floor(availableChars / 2);
  marker = markerFor(text.length - headChars - tailChars);
  availableChars = maxChars - marker.length;
  headChars = Math.ceil(availableChars / 2);
  tailChars = Math.floor(availableChars / 2);

  return `${text.slice(0, headChars)}${marker}${text.slice(text.length - tailChars)}`;
}

export function extractSubtitleCorrectionResult(text: string): SubtitleCorrectionResult {
  const jsonText = extractJsonObjectText(text);
  let value: unknown;
  try {
    value = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`LLM 输出不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isPlainObject(value)) {
    throw new Error("LLM 输出 JSON 必须是对象");
  }
  const segments = Array.isArray(value.segments) ? value.segments : null;
  const chapters = Array.isArray(value.chapters) ? value.chapters : null;
  if (!segments) throw new Error("LLM 输出缺少 segments 数组");
  if (!chapters) throw new Error("LLM 输出缺少 chapters 数组");

  return {
    segments: segments.map((segment, index) => normalizeSegment(segment, index)),
    chapters: chapters.map((chapter, index) => normalizeChapter(chapter, index)),
  };
}

async function loadDefaultPipeline(
  task: "text-generation",
  model: string,
  options: TextGenerationPipelineOptions,
): Promise<TextGenerationPipeline> {
  const module = await import("@huggingface/transformers");
  const pipe = await module.pipeline(task, model, options);
  return pipe as unknown as TextGenerationPipeline;
}

function readGeneratedText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output) && output.length > 0) {
    return readGeneratedText(output[0]);
  }
  if (isPlainObject(output) && typeof output.generated_text === "string") {
    return output.generated_text;
  }
  throw new Error("LLM 输出缺少 generated_text");
}

function extractJsonObjectText(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/u)?.[1]?.trim();
  if (fenced) return fenced;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("LLM 输出中未找到 JSON 对象");
  }
  return text.slice(start, end + 1);
}

function normalizeSegment(value: unknown, index: number): SubtitleCorrectionResult["segments"][number] {
  if (!isPlainObject(value) || typeof value.id !== "string" || typeof value.text !== "string") {
    throw new Error(`LLM segments[${index}] 格式非法`);
  }
  const id = value.id.trim();
  const text = value.text.trim();
  if (!id || !text) throw new Error(`LLM segments[${index}] 不能为空`);
  return { id, text };
}

function normalizeChapter(
  value: unknown,
  index: number,
): NonNullable<SubtitleCorrectionResult["chapters"]>[number] {
  if (
    !isPlainObject(value) ||
    typeof value.title !== "string" ||
    typeof value.startMs !== "number" ||
    !Number.isFinite(value.startMs)
  ) {
    throw new Error(`LLM chapters[${index}] 格式非法`);
  }
  const title = value.title.trim();
  if (!title) throw new Error(`LLM chapters[${index}] 标题不能为空`);
  const endMs =
    typeof value.endMs === "number" && Number.isFinite(value.endMs)
      ? Math.round(value.endMs)
      : undefined;
  return {
    title,
    startMs: Math.round(value.startMs),
    ...(typeof endMs === "number" ? { endMs } : {}),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
