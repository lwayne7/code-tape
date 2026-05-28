import { describe, expect, it } from "vitest";
import { normalizeTranscriptionResult } from "../subtitleTranscriber";

describe("normalizeTranscriptionResult", () => {
  it("turns Hugging Face ASR chunks into millisecond subtitle segments", () => {
    const segments = normalizeTranscriptionResult(
      {
        text: "We start with state, then render the loop.",
        chunks: [
          { text: " We start with state", timestamp: [0.32, 2.1] },
          { text: " then render the loop.", timestamp: [2.1, 4.75] },
        ],
      },
      5_000,
    );

    expect(segments).toEqual([
      { id: "subtitle-1", startMs: 320, endMs: 2_100, text: "We start with state" },
      { id: "subtitle-2", startMs: 2_100, endMs: 4_750, text: "then render the loop." },
    ]);
  });

  it("falls back to one full-duration segment when the model returns plain text", () => {
    const segments = normalizeTranscriptionResult({ text: "No chunk metadata." }, 7_500);

    expect(segments).toEqual([
      { id: "subtitle-1", startMs: 0, endMs: 7_500, text: "No chunk metadata." },
    ]);
  });

  it("drops empty chunks and clamps out-of-range timestamps", () => {
    const segments = normalizeTranscriptionResult(
      {
        chunks: [
          { text: "   ", timestamp: [0, 1] },
          { text: " valid ", timestamp: [-2, 12] },
        ],
      },
      3_000,
    );

    expect(segments).toEqual([
      { id: "subtitle-1", startMs: 0, endMs: 3_000, text: "valid" },
    ]);
  });
});
