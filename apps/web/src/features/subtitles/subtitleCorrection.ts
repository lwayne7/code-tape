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

export function applySubtitleCorrection(
  track: SubtitleTrack,
  correction: SubtitleCorrectionResult,
): ApplySubtitleCorrectionResult {
  const segmentIds = new Set(track.segments.map((segment) => segment.id));
  const correctedTextById = new Map<string, string>();

  for (const segment of correction.segments) {
    if (!segmentIds.has(segment.id)) {
      return invalid(track, "invalid-correction", `correction references unknown segment: ${segment.id}`);
    }
    const text = segment.text.trim();
    if (!text) {
      return invalid(track, "invalid-correction", `correction text is empty for segment: ${segment.id}`);
    }
    correctedTextById.set(segment.id, text);
  }

  const chapters = normalizeChapters(track, correction.chapters ?? []);
  if ("warning" in chapters) {
    return invalid(track, "invalid-chapter", chapters.warning);
  }

  return {
    track: {
      ...track,
      segments: track.segments.map((segment) => ({
        ...segment,
        text: correctedTextById.get(segment.id) ?? segment.text,
      })),
    },
    chapters,
    warnings: [],
  };
}

function normalizeChapters(
  track: SubtitleTrack,
  chapters: NonNullable<SubtitleCorrectionResult["chapters"]>,
): SubtitleChapter[] | { warning: string } {
  const durationMs = Math.max(0, ...track.segments.map((segment) => segment.endMs));
  let previousEnd = 0;
  const normalized: SubtitleChapter[] = [];
  for (let index = 0; index < chapters.length; index += 1) {
    const chapter = chapters[index];
    const title = chapter.title.trim();
    const startMs = Math.max(0, Math.min(durationMs, Math.round(chapter.startMs)));
    const endMs =
      typeof chapter.endMs === "number"
        ? Math.max(0, Math.min(durationMs, Math.round(chapter.endMs)))
        : undefined;

    if (!title) return { warning: "chapter title is empty" };
    if (startMs < previousEnd || (typeof endMs === "number" && endMs <= startMs)) {
      return { warning: "chapters must be ordered and non-overlapping" };
    }
    previousEnd = endMs ?? startMs;
    normalized.push({
      id: `chapter-${index + 1}`,
      title,
      startMs,
      ...(typeof endMs === "number" ? { endMs } : {}),
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
