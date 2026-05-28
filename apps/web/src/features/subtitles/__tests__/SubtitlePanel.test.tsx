import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SubtitlePanel } from "../SubtitlePanel";
import type { SubtitleStore, SubtitleTrack, SubtitleTrackDraft, SubtitleTranscriber } from "../types";

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

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
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

    const generateButton = screen.getByRole("button", { name: "生成字幕" });

    await waitFor(() => expect(generateButton).not.toBeDisabled());

    fireEvent.click(generateButton);

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

    const generateButton = screen.getByRole("button", { name: "生成字幕" });

    await waitFor(() => expect(generateButton).not.toBeDisabled());

    fireEvent.click(generateButton);

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("model unavailable"));
  });

  it("keeps generation disabled until saved subtitles finish loading", async () => {
    const loadedTrack = createDeferred<SubtitleTrack | null>();
    const store: SubtitleStore = {
      load: vi.fn(() => loadedTrack.promise),
      save: vi.fn(),
      remove: vi.fn(),
    };

    render(
      <SubtitlePanel
        recordingId="recording-1"
        mediaBlob={new Blob(["webm"], { type: "video/webm" })}
        hasAudio
        durationMs={3_000}
        currentTimeMs={0}
        onSeek={vi.fn()}
        store={store}
        transcriber={{
          transcribe: vi.fn(async () => ({
            model: "onnx-community/whisper-tiny",
            source: "huggingface-local" as const,
            segments: [],
          })),
        }}
      />,
    );

    const generateButton = screen.getByRole("button", { name: "生成字幕" });

    await waitFor(() => expect(generateButton).toBeDisabled());

    await act(async () => {
      loadedTrack.resolve(null);
      await flushPromises();
    });

    expect(generateButton).not.toBeDisabled();
  });

  it("ignores a generated track after switching to another recording", async () => {
    const generatedTrack = createDeferred<SubtitleTrackDraft>();
    const store: SubtitleStore = {
      load: vi.fn(async () => null),
      save: vi.fn(async () => undefined),
      remove: vi.fn(),
    };
    const transcriber: SubtitleTranscriber = {
      transcribe: vi.fn(() => generatedTrack.promise),
    };
    const firstBlob = new Blob(["first"], { type: "video/webm" });
    const secondBlob = new Blob(["second"], { type: "video/webm" });

    const { rerender } = render(
      <SubtitlePanel
        recordingId="recording-1"
        mediaBlob={firstBlob}
        hasAudio
        durationMs={3_000}
        currentTimeMs={0}
        onSeek={vi.fn()}
        store={store}
        transcriber={transcriber}
      />,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "生成字幕" })).not.toBeDisabled());

    fireEvent.click(screen.getByRole("button", { name: "生成字幕" }));

    rerender(
      <SubtitlePanel
        recordingId="recording-2"
        mediaBlob={secondBlob}
        hasAudio
        durationMs={3_000}
        currentTimeMs={0}
        onSeek={vi.fn()}
        store={store}
        transcriber={transcriber}
      />,
    );

    await act(async () => {
      generatedTrack.resolve({
        model: "onnx-community/whisper-tiny",
        source: "huggingface-local",
        segments: [{ id: "subtitle-1", startMs: 0, endMs: 1_000, text: "Old recording text." }],
      });
      await flushPromises();
    });

    expect(store.save).not.toHaveBeenCalled();
    expect(screen.queryByText("Old recording text.")).not.toBeInTheDocument();
  });

  it("warms up the transcriber when audio is available", async () => {
    const warmUp = vi.fn(async () => undefined);

    render(
      <SubtitlePanel
        recordingId="recording-1"
        mediaBlob={new Blob(["webm"], { type: "video/webm" })}
        hasAudio
        durationMs={3_000}
        currentTimeMs={0}
        onSeek={vi.fn()}
        store={createMemorySubtitleStore()}
        transcriber={{
          warmUp,
          transcribe: vi.fn(async () => ({
            model: "onnx-community/whisper-tiny",
            source: "huggingface-local" as const,
            segments: [],
          })),
        }}
      />,
    );

    await waitFor(() => expect(warmUp).toHaveBeenCalledTimes(1));
  });
});
