import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplayControlsProps } from "../ReplayControls";
import type { CodeEditorProps } from "@/features/editor/CodeEditor";
import type { PreviewPaneProps } from "@/features/runtime-preview/PreviewPane";
import type { ReplayStableState } from "@/shared/recording-schema";
import type * as ReactRouterDom from "react-router-dom";

const replayPageMock = vi.hoisted(() => {
  const schedulerState = {
    status: "ready" as const,
    timelineTimeMs: 0,
    playbackRate: 1 as const,
    lastAppliedSeq: 0,
    mediaStatus: "none" as const,
    driftMs: 0,
  };
  const packageData = {
    schemaVersion: "0.1.0",
    manifest: {
      packageId: "recording-1",
      schemaVersion: "0.1.0",
      status: "complete",
      createdAt: "2026-05-26T00:00:00.000Z",
      completedAt: "2026-05-26T00:01:00.000Z",
      checksums: { eventsSha256: "events", snapshotsSha256: "snapshots" },
    },
    meta: {
      id: "recording-1",
      title: "Replay controls",
      createdAt: "2026-05-26T00:00:00.000Z",
      durationMs: 120_000,
      appVersion: "test",
      ownerId: null,
      creatorInfo: null,
      initialLanguage: "javascript",
      initialFontSize: 14,
      initialTheme: "dark",
      mediaCapability: {
        audio: "unsupported",
        camera: "unsupported",
        selectedAudioDeviceId: null,
        selectedCameraDeviceId: null,
      },
    },
    events: [],
    snapshots: [],
    media: null,
  };
  const scheduler = {
    load: vi.fn(async () => {}),
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(async () => {}),
    setRate: vi.fn(),
    setVolume: vi.fn(),
    setMuted: vi.fn(),
    destroy: vi.fn(),
    subscribe: vi.fn((listener: (state: typeof schedulerState) => void) => {
      listener(schedulerState);
      return vi.fn();
    }),
  };
  const repository = {
    load: vi.fn(async () => ({ ok: true as const, package: packageData, warnings: [] })),
  };

  return {
    scheduler,
    repository,
    packageData,
    controlsProps: null as ReplayControlsProps | null,
    codeEditorProps: null as CodeEditorProps | null,
    previewPaneProps: null as PreviewPaneProps | null,
    onTick: null as ((state: ReplayStableState) => void) | null,
    reset() {
      scheduler.load.mockClear();
      scheduler.play.mockClear();
      scheduler.pause.mockClear();
      scheduler.seek.mockClear();
      scheduler.setRate.mockClear();
      scheduler.setVolume.mockClear();
      scheduler.setMuted.mockClear();
      scheduler.destroy.mockClear();
      scheduler.subscribe.mockClear();
      repository.load.mockClear();
      this.controlsProps = null;
      this.codeEditorProps = null;
      this.previewPaneProps = null;
      this.onTick = null;
    },
  };
});

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof ReactRouterDom>("react-router-dom");
  return {
    ...actual,
    useParams: () => ({ id: "recording-1" }),
  };
});

vi.mock("@/features/editor/CodeEditor", () => ({
  CodeEditor: (props: CodeEditorProps) => {
    replayPageMock.codeEditorProps = props;
    return <div aria-label="Mock code editor" />;
  },
}));

vi.mock("@/features/runtime-preview/PreviewPane", () => ({
  PreviewPane: (props: PreviewPaneProps) => {
    replayPageMock.previewPaneProps = props;
    return <div aria-label="Mock preview pane" />;
  },
}));

vi.mock("@/features/runtime-preview/iframeRuntime", () => ({
  createIframeRuntime: vi.fn(() => ({})),
}));

vi.mock("@/features/library/recordingStore", () => ({
  createRecordingStore: vi.fn(() => replayPageMock.repository),
}));

vi.mock("../replayScheduler", () => ({
  createReplayScheduler: vi.fn((options: { onTick?: (state: ReplayStableState) => void }) => {
    replayPageMock.onTick = options.onTick ?? null;
    return replayPageMock.scheduler;
  }),
  defaultTickStrategy: vi.fn(() => ({})),
}));

vi.mock("../ReplayControls", () => ({
  ReplayControls: (props: ReplayControlsProps) => {
    replayPageMock.controlsProps = props;
    return <div aria-label="Mock replay controls" />;
  },
}));

describe("ReplayPage", () => {
  beforeEach(() => {
    replayPageMock.reset();
  });

  it("wires replay control callbacks to scheduler commands", async () => {
    const { ReplayPage } = await import("../ReplayPage");

    render(<ReplayPage />);

    await waitFor(() => expect(replayPageMock.scheduler.load).toHaveBeenCalledWith(replayPageMock.packageData));
    expect(replayPageMock.controlsProps?.durationMs).toBe(120_000);

    await act(async () => {
      await replayPageMock.controlsProps?.onSeek(42_000);
    });
    act(() => {
      replayPageMock.controlsProps?.onPlay();
      replayPageMock.controlsProps?.onRate(1.5);
      replayPageMock.controlsProps?.onVolume(35);
      replayPageMock.controlsProps?.onMuted(true);
    });

    expect(replayPageMock.scheduler.seek).toHaveBeenCalledWith(42_000);
    expect(replayPageMock.scheduler.play).toHaveBeenCalledTimes(1);
    expect(replayPageMock.scheduler.setRate).toHaveBeenCalledWith(1.5);
    expect(replayPageMock.scheduler.setVolume).toHaveBeenCalledWith(35);
    expect(replayPageMock.scheduler.setMuted).toHaveBeenCalledWith(true);
    await waitFor(() => expect(replayPageMock.controlsProps?.volume).toBe(35));
    expect(replayPageMock.controlsProps?.muted).toBe(true);
  });

  it("renders scheduler stable state into the read-only editor and runtime panel", async () => {
    const { ReplayPage } = await import("../ReplayPage");

    render(<ReplayPage />);
    await waitFor(() => expect(replayPageMock.scheduler.load).toHaveBeenCalledWith(replayPageMock.packageData));

    act(() => {
      replayPageMock.onTick?.({
        editor: {
          code: "console.log('replayed');",
          language: "typescript",
          cursor: { lineNumber: 1, column: 8 },
          selection: {
            startLineNumber: 1,
            startColumn: 1,
            endLineNumber: 1,
            endColumn: 8,
          },
          scrollTop: 88,
          scrollLeft: 4,
          fontSize: 16,
          theme: "light",
        },
        pointer: null,
        media: { microphoneEnabled: false, cameraEnabled: false, cameraPosition: { x: 0, y: 0 } },
        runtime: {
          status: "error",
          stdout: ["hello"],
          stderr: ["warn"],
          previewHtml: "<main>preview</main>",
          errorMessage: "boom",
        },
      });
    });

    expect(replayPageMock.codeEditorProps).toEqual(
      expect.objectContaining({
        language: "typescript",
        value: "console.log('replayed');",
        readOnly: true,
        cursor: { lineNumber: 1, column: 8 },
        selection: {
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: 1,
          endColumn: 8,
        },
        scrollTop: 88,
        scrollLeft: 4,
        fontSize: 16,
        theme: "light",
      }),
    );
    expect(replayPageMock.previewPaneProps?.previewHtml).toBe("<main>preview</main>");
    expect(document.body).toHaveTextContent("hello");
    expect(document.body).toHaveTextContent("warn");
    expect(document.body).toHaveTextContent("boom");
  });
});
