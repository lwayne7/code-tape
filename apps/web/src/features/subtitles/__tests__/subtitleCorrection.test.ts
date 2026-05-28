import { describe, expect, it } from "vitest";
import { applySubtitleCorrection } from "../subtitleCorrection";
import type { SubtitleTrack } from "../types";

function makeTrack(): SubtitleTrack {
  return {
    recordingId: "recording-1",
    generatedAt: "2026-05-28T00:00:00.000Z",
    model: "onnx-community/whisper-tiny",
    source: "huggingface-local",
    segments: [
      { id: "subtitle-1", startMs: 0, endMs: 1_000, text: "use state hook" },
      { id: "subtitle-2", startMs: 1_000, endMs: 3_000, text: "render result" },
    ],
  };
}

describe("applySubtitleCorrection", () => {
  it("applies LLM text corrections and validated chapters without changing timestamps", () => {
    const result = applySubtitleCorrection(makeTrack(), {
      segments: [
        { id: "subtitle-1", text: "useState hook" },
        { id: "subtitle-2", text: "render the result" },
      ],
      chapters: [{ title: "State setup", startMs: 0, endMs: 1_000 }],
    });

    expect(result.warnings).toEqual([]);
    expect(result.track.segments).toEqual([
      { id: "subtitle-1", startMs: 0, endMs: 1_000, text: "useState hook" },
      { id: "subtitle-2", startMs: 1_000, endMs: 3_000, text: "render the result" },
    ]);
    expect(result.chapters).toEqual([{ id: "chapter-1", title: "State setup", startMs: 0, endMs: 1_000 }]);
  });

  it("keeps the original subtitles when the LLM output targets an unknown segment", () => {
    const track = makeTrack();
    const result = applySubtitleCorrection(track, {
      segments: [{ id: "missing", text: "bad correction" }],
    });

    expect(result.track).toEqual(track);
    expect(result.chapters).toEqual([]);
    expect(result.warnings).toEqual([
      { code: "invalid-correction", message: "correction references unknown segment: missing" },
    ]);
  });

  it("keeps the original subtitles when the LLM output omits a segment", () => {
    const track = makeTrack();
    const result = applySubtitleCorrection(track, {
      segments: [{ id: "subtitle-1", text: "useState hook" }],
    });

    expect(result.track).toEqual(track);
    expect(result.chapters).toEqual([]);
    expect(result.warnings).toEqual([
      { code: "invalid-correction", message: "correction must include every subtitle segment exactly once" },
    ]);
  });

  it("derives missing chapter end times from the next chapter or recording end", () => {
    const result = applySubtitleCorrection(makeTrack(), {
      segments: [
        { id: "subtitle-1", text: "问题分析" },
        { id: "subtitle-2", text: "代码实现" },
      ],
      chapters: [
        { title: "问题分析", startMs: 0 },
        { title: "代码实现", startMs: 1_000 },
      ],
    });

    expect(result.warnings).toEqual([]);
    expect(result.chapters).toEqual([
      { id: "chapter-1", title: "问题分析", startMs: 0, endMs: 1_000 },
      { id: "chapter-2", title: "代码实现", startMs: 1_000, endMs: 3_000 },
    ]);
  });

  it("keeps valid subtitle corrections when generated chapters overlap", () => {
    const track = makeTrack();
    const result = applySubtitleCorrection(track, {
      segments: [
        { id: "subtitle-1", text: "useState hook" },
        { id: "subtitle-2", text: "render result" },
      ],
      chapters: [
        { title: "First", startMs: 0, endMs: 2_000 },
        { title: "Overlap", startMs: 1_500, endMs: 3_000 },
      ],
    });

    expect(result.track.segments[0]?.text).toBe("useState hook");
    expect(result.chapters).toEqual([]);
    expect(result.warnings).toEqual([
      { code: "invalid-chapter", message: "chapters must be ordered and non-overlapping" },
    ]);
  });
});
