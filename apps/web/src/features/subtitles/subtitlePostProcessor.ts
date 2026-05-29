import type {
  SubtitleCorrectionResult,
  SubtitlePostProcessor,
  SubtitlePostProcessorContext,
  SubtitleTrack,
} from "./types";
import { DEFAULT_POSTPROCESSOR_MODEL } from "./subtitlePostProcessorConfig";

export { DEFAULT_POSTPROCESSOR_MODEL } from "./subtitlePostProcessorConfig";
const MAX_PROMPT_CODE_CHARS = 6_000;
const MAX_PROMPT_RUNTIME_OUTPUT_CHARS = 2_000;
const BASE_MAX_NEW_TOKENS = 128;
const MAX_POSTPROCESSOR_SEGMENTS = 120;
const MAX_DYNAMIC_NEW_TOKENS = 768;
const NEW_TOKENS_PER_SEGMENT = 5;
const CHAPTER_OUTPUT_TOKEN_RESERVE = 96;
const MAX_REPAIR_OUTPUT_CHARS = 1_000;
const ASCII_TERM_PRESERVATION_RATIO = 0.75;
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
    repetition_penalty: number;
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
  // Keep the cold-start path to the single validated browser target; final load errors are wrapped below.
  const pipelineOptions: TextGenerationPipelineOptions[] = [
    { device: "wasm", dtype: "q8" },
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
        repetition_penalty: 1.05,
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
        const recovered = recoverSubtitleCorrectionResult(generatedText, input.track);
        if (recovered) return recovered;
      }
      if (input.signal?.aborted) throw new DOMException("字幕纠错已取消", "AbortError");
      const retryOutput = await pipeline(buildSubtitlePostProcessorMessages(input, { previousOutput: generatedText }), {
        max_new_tokens: maxNewTokens,
        do_sample: false,
        repetition_penalty: 1.05,
        return_full_text: false,
        ...buildChatTemplateOption(model),
      });
      if (input.signal?.aborted) throw new DOMException("字幕纠错已取消", "AbortError");
      try {
        return constrainCorrectionToTrack(
          extractSubtitleCorrectionResult(readGeneratedText(retryOutput)),
          input.track,
        );
      } catch (error) {
        if (!isRecoverableJsonOutputError(error)) throw error;
        const recovered = recoverSubtitleCorrectionResult(readGeneratedText(retryOutput), input.track);
        if (recovered) return recovered;
      }
      return { segments: [], chapters: buildFallbackChapters(input.track) };
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
      if (!hasNextOption) {
        throw buildModelLoadError(error, options);
      }
      if (!isRecoverableModelLoadError(error, options)) {
        throw buildModelLoadError(error, options);
      }
    }
  }
  throw new Error("本地字幕 LLM 模型加载失败");
}

function buildModelLoadError(error: unknown, options: TextGenerationPipelineOptions): Error {
  const detail = error instanceof Error ? error.message : String(error);
  const wrapped = new Error(
    `当前浏览器无法加载本地字幕 LLM 模型（${options.device}/${options.dtype}）。请关闭其他占用内存的页面、升级浏览器后重试，或稍后再运行字幕纠错。原始错误：${detail}`,
  );
  if (error instanceof Error) {
    (wrapped as Error & { cause?: unknown }).cause = error;
  }
  return wrapped;
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
    inputSegments: track.segments.map((segment) => ({
      id: segment.id,
      text: segment.text,
    })),
    timeline: track.segments.map((segment) => ({
      id: segment.id,
      startMs: segment.startMs,
      endMs: segment.endMs,
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
    '输出结构示例：{"segments":[{"id":"subtitle-1","text":"这里用 useState 维护 count"}],"chapters":[{"title":"状态设计","startMs":0,"endMs":1000}]}',
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
        "Goal: correct ASR subtitle text for frontend/code terms and create playback chapter jump points.",
        "Input subtitle rows are in inputSegments.",
        "Timeline rows are in timeline.",
        "Only output JSON with segments and chapters. Do not output Markdown or explanations. 只输出 JSON。",
        "For speed, output only changed subtitle segments in segments. Omit unchanged segments.",
        "Each returned segment must contain only id and text.",
        "Generate short playback chapter jump points from subtitle content and timestamps.",
        'Output shape example: {"segments":[{"id":"subtitle-1","text":"这里用 useState 维护 count"}],"chapters":[{"title":"状态设计","startMs":0,"endMs":1000}]}',
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
    inputSegments: track.segments.map((segment) => ({
      id: segment.id,
      text: segment.text,
    })),
    timeline: track.segments.map((segment) => ({
      id: segment.id,
      startMs: segment.startMs,
      endMs: segment.endMs,
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
  return (
    error.message.startsWith("LLM 输出") ||
    error.message.startsWith("LLM segments") ||
    error.message.startsWith("LLM chapters")
  );
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
  return {
    ...correction,
    segments: constrainCorrectionSegments(correction.segments, track),
    chapters: constrainCorrectionChaptersToTrack(correction.chapters ?? [], track),
  };
}

function constrainCorrectionChaptersToTrack(
  chapters: NonNullable<SubtitleCorrectionResult["chapters"]>,
  track: SubtitleTrack,
): NonNullable<SubtitleCorrectionResult["chapters"]> {
  const subtitleEndMs = Math.max(0, ...track.segments.map((segment) => segment.endMs));
  const seenTimelines = new Set<string>();
  return chapters
    .filter((chapter) => chapter.startMs < subtitleEndMs)
    .filter((chapter) => !chapter.title.includes("\uFFFD"))
    .map((chapter) => ({
      ...chapter,
      ...(typeof chapter.endMs === "number"
        ? { endMs: Math.min(chapter.endMs, subtitleEndMs) }
        : {}),
    }))
    .filter((chapter) => chapter.endMs === undefined || chapter.endMs > chapter.startMs)
    .filter((chapter) => keepUniqueChapterTimeline(chapter, seenTimelines));
}

function keepUniqueChapterTimeline(
  chapter: NonNullable<SubtitleCorrectionResult["chapters"]>[number],
  seenTimelines: Set<string>,
): boolean {
  const key = `${chapter.startMs}:${chapter.endMs ?? ""}`;
  if (seenTimelines.has(key)) return false;
  seenTimelines.add(key);
  return true;
}

function constrainCorrectionSegments(
  segments: SubtitleCorrectionResult["segments"],
  track: SubtitleTrack,
): SubtitleCorrectionResult["segments"] {
  const sourceTextById = new Map(track.segments.map((segment) => [segment.id, segment.text]));
  const seenSegmentIds = new Set<string>();
  return segments.filter((segment) => {
    const sourceText = sourceTextById.get(segment.id);
    if (sourceText === undefined) return dropCorrectionSegment(segment.id, "unknown-segment");
    if (seenSegmentIds.has(segment.id)) return dropCorrectionSegment(segment.id, "duplicate-segment");
    if (!segment.text.trim()) return dropCorrectionSegment(segment.id, "empty-text");
    if (segment.text.includes("\uFFFD")) return dropCorrectionSegment(segment.id, "replacement-character");
    if (!isPlausibleTextCorrection(sourceText, segment.text)) {
      return dropCorrectionSegment(segment.id, "implausible-text");
    }
    seenSegmentIds.add(segment.id);
    return true;
  });
}

function dropCorrectionSegment(segmentId: string, reason: string): false {
  console.debug("[code-tape] dropped subtitle correction", { segmentId, reason });
  return false;
}

function recoverSubtitleCorrectionResult(
  text: string,
  track: SubtitleTrack,
): SubtitleCorrectionResult | null {
  let value: unknown;
  try {
    value = JSON.parse(extractJsonObjectText(text));
  } catch {
    return null;
  }
  if (!isPlainObject(value)) return null;

  const segments = constrainCorrectionSegments(readLooseCorrectionSegments(value), track);
  const chapters = readLooseCorrectionChapters(value, track);
  return constrainCorrectionToTrack(
    {
      segments,
      chapters: chapters.length > 0 ? chapters : buildFallbackChapters(track, segments),
    },
    track,
  );
}

function readLooseCorrectionSegments(value: Record<string, unknown>): SubtitleCorrectionResult["segments"] {
  const rawSegments = Array.isArray(value.segments)
    ? value.segments
    : Object.entries(value)
        .filter(([id, text]) => id.startsWith("subtitle-") && typeof text === "string")
        .map(([id, text]) => ({ id, text }));

  return rawSegments.flatMap((segment, index) => {
    try {
      return [normalizeSegment(segment, index)];
    } catch {
      return [];
    }
  });
}

function readLooseCorrectionChapters(
  value: Record<string, unknown>,
  track: SubtitleTrack,
): NonNullable<SubtitleCorrectionResult["chapters"]> {
  if (Array.isArray(value.chapters)) {
    return value.chapters.flatMap((chapter, index) => {
      try {
        return [normalizeChapter(chapter, index)];
      } catch {
        return [];
      }
    });
  }

  if (!Array.isArray(value.titles)) return [];
  const timelineById = new Map(track.segments.map((segment) => [segment.id, segment]));
  const seenSegmentIds = new Set<string>();
  const chapters: NonNullable<SubtitleCorrectionResult["chapters"]> = [];
  for (const title of value.titles) {
    if (!isPlainObject(title)) continue;
    if (typeof title.title === "string" && typeof title.startMs === "number") {
      try {
        chapters.push(normalizeChapter(title, chapters.length));
      } catch {
        // Keep recovering other loose chapter entries.
      }
      continue;
    }
    if (typeof title.id !== "string" || typeof title.text !== "string") continue;
    if (seenSegmentIds.has(title.id)) continue;
    const segment = timelineById.get(title.id);
    if (!segment) continue;
    seenSegmentIds.add(title.id);
    chapters.push({
      title: fallbackChapterTitle(chapters.length),
      startMs: segment.startMs,
      endMs: segment.endMs,
    });
  }
  return chapters;
}

function buildFallbackChapters(
  track: SubtitleTrack,
  corrections: SubtitleCorrectionResult["segments"] = [],
): NonNullable<SubtitleCorrectionResult["chapters"]> {
  const correctedTextById = new Map(corrections.map((segment) => [segment.id, segment.text]));
  const segments = track.segments
    .map((segment) => ({
      ...segment,
      text: correctedTextById.get(segment.id) ?? segment.text,
    }))
    .filter((segment) => segment.endMs > segment.startMs);
  if (segments.length === 0) return [];

  const chapterCount = Math.min(3, segments.length);
  const chunkSize = Math.ceil(segments.length / chapterCount);
  const chapters: NonNullable<SubtitleCorrectionResult["chapters"]> = [];
  for (let index = 0; index < chapterCount; index += 1) {
    const chunk = segments.slice(index * chunkSize, (index + 1) * chunkSize);
    const first = chunk[0];
    const last = chunk.at(-1);
    if (!first || !last) continue;
    chapters.push({
      title: fallbackChapterTitle(index),
      startMs: first.startMs,
      endMs: last.endMs,
    });
  }
  return chapters;
}

function fallbackChapterTitle(index: number): string {
  return `片段 ${index + 1}`;
}

function isPlausibleTextCorrection(sourceText: string, correctedText: string): boolean {
  const sourceTerms = extractAsciiTerms(sourceText);
  if (sourceTerms.length > 0) {
    const corrected = normalizeAsciiText(correctedText);
    const preservedTerms = sourceTerms.filter((term) => corrected.includes(term));
    const requiredPreservedTerms = Math.ceil(sourceTerms.length * ASCII_TERM_PRESERVATION_RATIO);
    return preservedTerms.length >= requiredPreservedTerms || hasNearFusedCodeTerm(sourceTerms, correctedText);
  }

  const sourceChars = extractCjkChars(sourceText);
  if (sourceChars.length === 0) return true;
  const correctedChars = new Set(extractCjkChars(correctedText));
  const sharedChars = sourceChars.filter((char) => correctedChars.has(char)).length;
  return sharedChars / sourceChars.length >= 0.35;
}

function extractAsciiTerms(text: string): string[] {
  return [...new Set(text.match(/[a-z][a-z0-9_.$-]*/giu)?.map(normalizeAsciiText) ?? [])]
    .filter((term) => term.length >= 2);
}

function hasNearFusedCodeTerm(sourceTerms: string[], correctedText: string): boolean {
  const correctedTerms = extractAsciiTerms(correctedText);
  for (const fusedSourceTerm of buildFusedSourceTerms(sourceTerms)) {
    for (const correctedTerm of correctedTerms) {
      if (isNearCodeTerm(fusedSourceTerm, correctedTerm)) return true;
    }
  }
  return false;
}

function buildFusedSourceTerms(sourceTerms: string[]): string[] {
  const terms = new Set<string>();
  for (let start = 0; start < sourceTerms.length; start += 1) {
    for (let end = start + 2; end <= sourceTerms.length; end += 1) {
      terms.add(sourceTerms.slice(start, end).join(""));
    }
  }
  return [...terms];
}

function isNearCodeTerm(sourceTerm: string, correctedTerm: string): boolean {
  if (sourceTerm.length < 5 || correctedTerm.length < 5) return false;
  const maxDistance = Math.max(1, Math.floor(Math.max(sourceTerm.length, correctedTerm.length) * 0.2));
  return levenshteinDistanceWithin(sourceTerm, correctedTerm, maxDistance);
}

function levenshteinDistanceWithin(left: string, right: string, maxDistance: number): boolean {
  if (Math.abs(left.length - right.length) > maxDistance) return false;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    let rowMinimum = current[0] ?? leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      const distance = Math.min(
        (previous[rightIndex] ?? 0) + 1,
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + substitutionCost,
      );
      current[rightIndex] = distance;
      rowMinimum = Math.min(rowMinimum, distance);
    }
    if (rowMinimum > maxDistance) return false;
    previous = current;
  }
  return (previous[right.length] ?? Number.POSITIVE_INFINITY) <= maxDistance;
}

function normalizeAsciiText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9_.$-]/gu, "");
}

function extractCjkChars(text: string): string[] {
  return [...new Set(text.match(/\p{Script=Han}/gu) ?? [])];
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
