import type {
  SubtitleChapter,
  SubtitleCorrectionResult,
  SubtitleCorrectionWarning,
  SubtitleTrack,
} from "./types";

export type ApplySubtitleCorrectionResult = {
  track: SubtitleTrack;
  chapters: SubtitleChapter[];
  warnings: SubtitleCorrectionWarning[];
};

export type ApplySubtitleCorrectionOptions = {
  durationMs?: number;
};

export function applySubtitleCorrection(
  track: SubtitleTrack,
  correction: SubtitleCorrectionResult,
  options: ApplySubtitleCorrectionOptions = {},
): ApplySubtitleCorrectionResult {
  const segmentIds = new Set(track.segments.map((segment) => segment.id));
  const correctedTextById = new Map<string, string>();

  for (const segment of correction.segments) {
    if (!segmentIds.has(segment.id)) {
      return invalid(track, "invalid-correction", `correction references unknown segment: ${segment.id}`);
    }
    if (correctedTextById.has(segment.id)) {
      return invalid(track, "invalid-correction", `correction repeats subtitle segment: ${segment.id}`);
    }
    const text = segment.text.trim();
    if (!text) {
      return invalid(track, "invalid-correction", `correction text is empty for segment: ${segment.id}`);
    }
    correctedTextById.set(segment.id, text);
  }

  const correctedTrack: SubtitleTrack = {
    ...track,
    segments: track.segments.map((segment) => ({
      ...segment,
      text: correctedTextById.get(segment.id) ?? segment.text,
    })),
  };

  const chapters = normalizeChapters(track, correction.chapters ?? [], options);
  if ("warning" in chapters) {
    return invalid(correctedTrack, "invalid-chapter", chapters.warning);
  }

  return {
    track: correctedTrack,
    chapters,
    warnings: [],
  };
}

function normalizeChapters(
  track: SubtitleTrack,
  chapters: NonNullable<SubtitleCorrectionResult["chapters"]>,
  options: ApplySubtitleCorrectionOptions,
): SubtitleChapter[] | { warning: string } {
  const subtitleEndMs = Math.max(0, ...track.segments.map((segment) => segment.endMs));
  const recordingEndMs =
    typeof options.durationMs === "number" && Number.isFinite(options.durationMs)
      ? Math.round(options.durationMs)
      : 0;
  const durationMs = Math.max(subtitleEndMs, recordingEndMs);
  const candidates: Array<{
    title: string;
    startMs: number;
    endMs?: number;
  }> = [];

  for (const chapter of chapters) {
    const title = chapter.title.trim();
    const startMs = Math.max(0, Math.min(durationMs, Math.round(chapter.startMs)));
    const endMs =
      typeof chapter.endMs === "number"
        ? Math.max(0, Math.min(durationMs, Math.round(chapter.endMs)))
        : undefined;

    if (!title) return { warning: "chapter title is empty" };
    candidates.push({
      title,
      startMs,
      ...(typeof endMs === "number" ? { endMs } : {}),
    });
  }

  let previousEnd = 0;
  const normalized: SubtitleChapter[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const chapter = candidates[index];
    const nextStartMs = candidates[index + 1]?.startMs ?? durationMs;
    const endMs = chapter.endMs ?? nextStartMs;

    if (
      chapter.startMs < previousEnd ||
      endMs <= chapter.startMs ||
      endMs > durationMs ||
      endMs > nextStartMs
    ) {
      return { warning: "chapters must be ordered and non-overlapping" };
    }
    previousEnd = endMs;
    normalized.push({
      id: `chapter-${index + 1}`,
      title: chapter.title,
      startMs: chapter.startMs,
      endMs,
    });
  }
  return normalized;
}

function invalid(
  track: SubtitleTrack,
  code: SubtitleCorrectionWarning["code"],
  message: string,
): ApplySubtitleCorrectionResult {
  return { track, chapters: [], warnings: [{ code, message }] };
}
