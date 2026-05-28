import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { createSubtitleStore } from "../subtitleStore";
import type { SubtitleChapter, SubtitleTrack } from "../types";

let dbCounter = 0;
function uniqueDbName() {
  dbCounter += 1;
  return `code-tape-subtitles-test-${dbCounter}`;
}

describe("createSubtitleStore", () => {
  it("round-trips a generated subtitle track by recording id", async () => {
    const store = createSubtitleStore({ databaseName: uniqueDbName() });
    const track: SubtitleTrack = {
      recordingId: "recording-1",
      generatedAt: "2026-05-28T00:00:00.000Z",
      model: "onnx-community/whisper-tiny",
      source: "huggingface-local",
      segments: [
        { id: "subtitle-1", startMs: 0, endMs: 1_200, text: "Hello timeline." },
      ],
    };

    await store.save(track);

    await expect(store.load("recording-1")).resolves.toEqual(track);
    await expect(store.load("missing")).resolves.toBeNull();
  });

  it("round-trips generated chapters separately from the subtitle track", async () => {
    const store = createSubtitleStore({ databaseName: uniqueDbName() });
    const chapters: SubtitleChapter[] = [
      { id: "chapter-1", title: "问题分析", startMs: 0, endMs: 1_200 },
      { id: "chapter-2", title: "代码实现", startMs: 1_200 },
    ];

    await store.saveChapters("recording-1", chapters);

    await expect(store.loadChapters("recording-1")).resolves.toEqual(chapters);
    await expect(store.loadChapters("missing")).resolves.toEqual([]);
  });
});
