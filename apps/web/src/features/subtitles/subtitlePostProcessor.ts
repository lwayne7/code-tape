import type {
  SubtitleCorrectionResult,
  SubtitlePostProcessor,
  SubtitlePostProcessorContext,
  SubtitleTrack,
} from "./types";

export const DEFAULT_POSTPROCESSOR_MODEL =
  "onnx-community/Qwen2.5-0.5B-Instruct";
const MAX_PROMPT_CODE_CHARS = 6_000;
const MAX_PROMPT_RUNTIME_OUTPUT_CHARS = 2_000;
const BASE_MAX_NEW_TOKENS = 384;
const MAX_POSTPROCESSOR_SEGMENTS = 120;
const MAX_DYNAMIC_NEW_TOKENS = 3_072;
const NEW_TOKENS_PER_SEGMENT = 16;
const CHAPTER_OUTPUT_TOKEN_RESERVE = 256;
const MAX_REPAIR_OUTPUT_CHARS = 1_000;
const SMOLLM_CHAT_TEMPLATE = `{% for message in messages %}{% if loop.first and messages[0]['role'] != 'system' %}{{ '<|im_start|>system
You are a helpful AI assistant named SmolLM, trained by Hugging Face<|im_end|>
' }}{% endif %}{{'<|im_start|>' + message['role'] + '
' + message['content'] + '<|im_end|>' + '
'}}{% endfor %}{% if add_generation_prompt %}{{ '<|im_start|>assistant
' }}{% endif %}`;

type SubtitlePostProcessorMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type TextGenerationPipelineOptions = {
  device: "webgpu" | "wasm";
  dtype: "q4" | "q4f16" | "q8";
};

type TextGenerationPipeline = (
  prompt: string | SubtitlePostProcessorMessage[],
  options: {
    max_new_tokens: number;
    do_sample: boolean;
    return_full_text: boolean;
    chat_template?: string;
  },
) => Promise<unknown>;

type PipelineFactory = (
  task: "text-generation",
  model: string,
  options: TextGenerationPipelineOptions,
) => Promise<TextGenerationPipeline>;

type TransformersEnvironment = {
  useBrowserCache?: boolean;
  useCustomCache?: boolean;
  customCache?: QuietBrowserCache | null;
  cacheKey?: string;
};

type QuietBrowserCache = {
  __codeTapeQuietCache: true;
  match(cacheKey: string): Promise<Response | undefined>;
  put(cacheKey: string, response: Response): Promise<void>;
};

export type HuggingFaceSubtitlePostProcessorOptions = {
  model?: string;
  pipelineFactory?: PipelineFactory;
};

export function createHuggingFaceSubtitlePostProcessor(
  options: HuggingFaceSubtitlePostProcessorOptions = {},
): SubtitlePostProcessor {
  const model = options.model ?? DEFAULT_POSTPROCESSOR_MODEL;
  const pipelineOptions: TextGenerationPipelineOptions[] = [
    { device: "webgpu", dtype: "q4f16" },
    { device: "webgpu", dtype: "q4" },
    { device: "wasm", dtype: "q8" },
    { device: "wasm", dtype: "q4" },
  ];
  let pipelinePromise: Promise<TextGenerationPipeline> | null = null;
  const getPipeline = () => {
    if (!pipelinePromise) {
      pipelinePromise = loadPipelineWithFallback({
        model,
        pipelineFactory: options.pipelineFactory,
        pipelineOptions,
      }).catch((error: unknown) => {
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
      const maxNewTokens = estimateMaxNewTokens(input.track);
      const pipeline = await getPipeline();
      if (input.signal?.aborted) throw new DOMException("字幕纠错已取消", "AbortError");
      const output = await pipeline(buildSubtitlePostProcessorMessages(input), {
        max_new_tokens: maxNewTokens,
        do_sample: false,
        return_full_text: false,
        ...buildChatTemplateOption(model),
      });
      if (input.signal?.aborted) throw new DOMException("字幕纠错已取消", "AbortError");
      const generatedText = readGeneratedText(output);
      try {
        return constrainCorrectionToTrack(
          extractSubtitleCorrectionResult(generatedText),
          input.track,
        );
      } catch (error) {
        if (!isRecoverableJsonOutputError(error)) throw error;
      }
      if (input.signal?.aborted) throw new DOMException("字幕纠错已取消", "AbortError");
      const retryOutput = await pipeline(buildSubtitlePostProcessorMessages(input, { previousOutput: generatedText }), {
        max_new_tokens: maxNewTokens,
        do_sample: false,
        return_full_text: false,
        ...buildChatTemplateOption(model),
      });
      if (input.signal?.aborted) throw new DOMException("字幕纠错已取消", "AbortError");
      return constrainCorrectionToTrack(
        extractSubtitleCorrectionResult(readGeneratedText(retryOutput)),
        input.track,
      );
    },
  };
}

async function loadPipelineWithFallback({
  model,
  pipelineFactory,
  pipelineOptions,
}: {
  model: string;
  pipelineFactory?: PipelineFactory;
  pipelineOptions: TextGenerationPipelineOptions[];
}): Promise<TextGenerationPipeline> {
  for (const [index, options] of pipelineOptions.entries()) {
    try {
      return pipelineFactory
        ? await pipelineFactory("text-generation", model, options)
        : await loadDefaultPipeline("text-generation", model, options);
    } catch (error) {
      const hasNextOption = index < pipelineOptions.length - 1;
      if (!hasNextOption || !isRecoverableModelLoadError(error, options)) {
        throw error;
      }
    }
  }
  throw new Error("本地字幕 LLM 模型加载失败");
}

function isRecoverableModelLoadError(
  error: unknown,
  options: TextGenerationPipelineOptions,
): boolean {
  return (
    options.device === "webgpu" ||
    isQuantizedWeightCompatibilityError(error) ||
    isMissingModelArtifactError(error)
  );
}

function buildChatTemplateOption(model: string): { chat_template?: string } {
  return model.includes("code-tape-subtitle-postprocessor") ? { chat_template: SMOLLM_CHAT_TEMPLATE } : {};
}

function isQuantizedWeightCompatibilityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("TransposeDQWeightsForMatMulNBits") ||
    message.includes("MatMulNBits") ||
    message.includes("Missing required scale")
  );
}

function isMissingModelArtifactError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Could not locate file") ||
    message.includes("Could not load model") ||
    message.includes("404") ||
    message.includes("Not Found")
  );
}

function estimateMaxNewTokens(track: SubtitleTrack): number {
  const segmentCount = track.segments.length;
  if (segmentCount > MAX_POSTPROCESSOR_SEGMENTS) {
    throw new Error(
      `字幕段过多（${segmentCount} 段），浏览器本地 LLM 单次最多支持 ${MAX_POSTPROCESSOR_SEGMENTS} 段；请先拆分录制或缩短片段后再运行 AI 纠错。`,
    );
  }
  return Math.min(
    MAX_DYNAMIC_NEW_TOKENS,
    Math.max(BASE_MAX_NEW_TOKENS, segmentCount * NEW_TOKENS_PER_SEGMENT + CHAPTER_OUTPUT_TOKEN_RESERVE),
  );
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
    "- 修正前端术语、变量名、函数名、组件名和明显的 ASR 误识别。",
    "- segments 只返回需要修改的 segments；不需要修改的字幕段请省略，应用会保留原文。",
    "- segments 只能引用输入中已有的 id，不能改 startMs/endMs。",
    "- chapters 必须按时间递增、互不重叠，标题要短，适合回放导航。",
    "- chapters 必须位于输入字幕时间轴内，不能在最后一个字幕 endMs 之后创建章节。",
    "- 无法可靠生成章节时也必须输出 chapters: []。",
    "输出 JSON 结构：",
    '{"segments":[{"id":"subtitle-1","text":"修正后的文本"}],"chapters":[{"title":"问题分析","startMs":0,"endMs":1000}]}',
    "输入：",
    JSON.stringify(payload),
  ].join("\n");
}

export function buildSubtitlePostProcessorMessages(
  input: {
    track: SubtitleTrack;
    context?: SubtitlePostProcessorContext;
  },
  options: { previousOutput?: string } = {},
): SubtitlePostProcessorMessage[] {
  const payload = buildSubtitlePostProcessorPayload(input);
  const messages: SubtitlePostProcessorMessage[] = [
    {
      role: "system",
      content: [
        "You are the code-tape subtitle post-processing model.",
        "Only output one JSON object. Do not output Markdown, explanations, prefixes, suffixes, or code fences. 只输出 JSON。",
        "Goal: correct ASR subtitle text for frontend/code terms and create playback chapter jump points.",
        "For speed, output only changed subtitle segments in segments. Omit unchanged segments; the app keeps their original text.",
        "Generate short playback chapter jump points from subtitle content and timestamps.",
        "Chapters must stay inside the input subtitle timeline. Do not create chapters at or after the final segment endMs.",
        'Output shape: {"segments":[{"id":"subtitle-1","text":"corrected text"}],"chapters":[{"title":"问题分析","startMs":0,"endMs":1000}]}',
        "The response must start with { and end with }.",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify(payload),
    },
  ];
  if (options.previousOutput !== undefined) {
    messages.push(
      {
        role: "assistant",
        content: budgetPromptText(options.previousOutput, MAX_REPAIR_OUTPUT_CHARS),
      },
      {
        role: "user",
        content: [
          "Previous output did not contain a parseable JSON object.",
          "Output exactly one JSON object with segments and chapters arrays.",
          "No explanations, Markdown, code fences, or text outside JSON.",
        ].join("\n"),
      },
    );
  }
  return messages;
}

function buildSubtitlePostProcessorPayload({
  track,
  context,
}: {
  track: SubtitleTrack;
  context?: SubtitlePostProcessorContext;
}) {
  return {
    context: {
      fileName: context?.fileName ?? null,
      code: budgetPromptText(context?.code ?? "", MAX_PROMPT_CODE_CHARS),
      runtimeOutput: budgetPromptText(
        context?.runtimeOutput ?? "",
        MAX_PROMPT_RUNTIME_OUTPUT_CHARS,
      ),
      glossary: context?.glossary ?? [],
    },
    segments: track.segments.map((segment) => ({
      id: segment.id,
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
    })),
  };
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

function isRecoverableJsonOutputError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.startsWith("LLM 输出");
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

function constrainCorrectionToTrack(
  correction: SubtitleCorrectionResult,
  track: SubtitleTrack,
): SubtitleCorrectionResult {
  const subtitleEndMs = Math.max(0, ...track.segments.map((segment) => segment.endMs));
  const chapters = (correction.chapters ?? [])
    .filter((chapter) => chapter.startMs < subtitleEndMs)
    .filter((chapter) => !chapter.title.includes("\uFFFD"))
    .map((chapter) => ({
      ...chapter,
      ...(typeof chapter.endMs === "number"
        ? { endMs: Math.min(chapter.endMs, subtitleEndMs) }
        : {}),
    }))
    .filter((chapter) => chapter.endMs === undefined || chapter.endMs > chapter.startMs);
  return { ...correction, chapters };
}

async function loadDefaultPipeline(
  task: "text-generation",
  model: string,
  options: TextGenerationPipelineOptions,
): Promise<TextGenerationPipeline> {
  const module = await import("@huggingface/transformers");
  configureQuietBrowserCache(module.env as TransformersEnvironment | undefined);
  const pipe = await module.pipeline(task, model, options);
  return pipe as unknown as TextGenerationPipeline;
}

function configureQuietBrowserCache(env: TransformersEnvironment | undefined): void {
  if (!env?.useBrowserCache || typeof globalThis.caches === "undefined") return;
  if (env.useCustomCache && env.customCache) return;

  const cacheKey = env.cacheKey ?? "transformers-cache";
  env.useCustomCache = true;
  env.customCache = {
    __codeTapeQuietCache: true,
    async match(resourceKey) {
      try {
        const cache = await globalThis.caches.open(cacheKey);
        return (await cache.match(resourceKey)) ?? undefined;
      } catch {
        return undefined;
      }
    },
    async put(resourceKey, response) {
      try {
        const cache = await globalThis.caches.open(cacheKey);
        await cache.put(resourceKey, response.clone());
      } catch {
        // Cache API writes can fail for large model files or browser storage issues.
        // Model loading has already succeeded, so keep inference available and avoid noisy warnings.
      }
    },
  };
}

function readGeneratedText(output: unknown): string {
  const text = readGeneratedTextCandidate(output);
  if (text !== null) return text;
  throw new Error("LLM 输出缺少 generated_text");
}

function readGeneratedTextCandidate(output: unknown): string | null {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    const assistantContent = readAssistantMessageContent(output);
    if (assistantContent !== null) return assistantContent;
    return output.length > 0 ? readGeneratedTextCandidate(output[0]) : null;
  }
  if (isPlainObject(output)) {
    return readGeneratedTextCandidate(output.generated_text);
  }
  return null;
}

function readAssistantMessageContent(messages: unknown[]): string | null {
  const assistantMessage = [...messages]
    .reverse()
    .find(
      (message): message is { role: string; content: string } =>
        isPlainObject(message) &&
        message.role === "assistant" &&
        typeof message.content === "string",
    );
  return assistantMessage?.content ?? null;
}

function extractJsonObjectText(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/u)?.[1]?.trim();
  const source = fenced ?? text;
  const start = source.indexOf("{");
  if (start === -1) {
    throw new Error("LLM 输出中未找到 JSON 对象");
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = inString;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  throw new Error("LLM 输出中未找到完整 JSON 对象");
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
