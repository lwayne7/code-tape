import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SubtitlePanel } from "../SubtitlePanel";
import type { SubtitleStore, SubtitleTranscriber } from "../types";

function createMemorySubtitleStore(): SubtitleStore {
  const tracks = new Map();
  return {
    async load(recordingId) {
      return tracks.get(recordingId) ?? null;
    },
    async save(track) {
      tracks.set(track.recordingId, track);
    },
    async remove(recordingId) {
      tracks.delete(recordingId);
    },
  };
}

describe("SubtitlePanel", () => {
  it("generates subtitles from the media blob, highlights the active segment, and seeks on click", async () => {
    const store = createMemorySubtitleStore();
    const transcriber: SubtitleTranscriber = {
      transcribe: vi.fn(async () => ({
        model: "onnx-community/whisper-tiny",
        source: "huggingface-local" as const,
        segments: [
          { id: "subtitle-1", startMs: 0, endMs: 1_000, text: "Set up state." },
          { id: "subtitle-2", startMs: 1_000, endMs: 3_000, text: "Render the result." },
        ],
      })),
    };
    const onSeek = vi.fn();

    render(
      <SubtitlePanel
        recordingId="recording-1"
        mediaBlob={new Blob(["webm"], { type: "video/webm" })}
        hasAudio
        durationMs={3_000}
        currentTimeMs={1_500}
        onSeek={onSeek}
        store={store}
        transcriber={transcriber}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "生成字幕" }));

    await waitFor(() => expect(screen.getByText("Render the result.")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Render the result." })).toHaveAttribute(
      "aria-current",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "Set up state." }));

    expect(onSeek).toHaveBeenCalledWith(0);
    await expect(store.load("recording-1")).resolves.toEqual(
      expect.objectContaining({
        recordingId: "recording-1",
        model: "onnx-community/whisper-tiny",
        source: "huggingface-local",
      }),
    );
  });

  it("surfaces generation failure without blocking replay controls", async () => {
    const transcriber: SubtitleTranscriber = {
      transcribe: vi.fn(async () => {
        throw new Error("model unavailable");
      }),
    };

    render(
      <SubtitlePanel
        recordingId="recording-1"
        mediaBlob={new Blob(["webm"], { type: "video/webm" })}
        hasAudio
        durationMs={3_000}
        currentTimeMs={0}
        onSeek={vi.fn()}
        store={createMemorySubtitleStore()}
        transcriber={transcriber}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "生成字幕" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("model unavailable"));
  });
});
