import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { Link, useParams } from "react-router-dom";
import { createReplayScheduler, defaultTickStrategy } from "./replayScheduler";
import { createTimelineClock } from "./timelineClock";
import { ReplayControls } from "./ReplayControls";
import { createMediaClockAdapter } from "./mediaClockAdapter";
import { CodeEditor } from "@/features/editor/CodeEditor";
import { PreviewPane } from "@/features/runtime-preview/PreviewPane";
import { createIframeRuntime } from "@/features/runtime-preview/iframeRuntime";
import { createRecordingStore } from "@/features/library/recordingStore";
import type {
  RecordingEvent,
  RecordingPackageV1,
  ReplaySchedulerState,
  ReplayStableState,
} from "@/shared/recording-schema";

const INITIAL_SCHEDULER_STATE: ReplaySchedulerState = {
  status: "loading",
  timelineTimeMs: 0,
  playbackRate: 1,
  lastAppliedSeq: 0,
  mediaStatus: "none",
  driftMs: 0,
};

const INITIAL_STABLE_STATE: ReplayStableState = {
  editor: {
    code: "",
    language: "javascript",
    cursor: null,
    selection: null,
    scrollTop: 0,
    scrollLeft: 0,
    fontSize: 14,
    theme: "dark",
  },
  pointer: null,
  media: { microphoneEnabled: false, cameraEnabled: false, cameraPosition: { x: 0, y: 0 } },
  runtime: { status: "idle", stdout: [], stderr: [], previewHtml: null, errorMessage: null },
};

type ReplayOverlayState = {
  pointer: {
    id: string;
    xPercent: number;
    yPercent: number;
    clicked: boolean;
  } | null;
  shortcut: {
    id: string;
    label: string;
  } | null;
};

const EMPTY_OVERLAY_STATE: ReplayOverlayState = { pointer: null, shortcut: null };
const TRANSIENT_OVERLAY_TTL_MS = 900;
const MEDIA_DRIFT_THRESHOLD_MS = 250;

/**
 * ReplayPage — wires the replay core (scheduler + clock + repository + runtime)
 * and renders the playback layout.
 */
export function ReplayPage() {
  const { id } = useParams();
  const repository = useMemo(() => createRecordingStore(), []);
  const runtime = useMemo(() => createIframeRuntime(), []);
  const [schedulerState, setSchedulerState] =
    useState<ReplaySchedulerState>(INITIAL_SCHEDULER_STATE);
  const [stableState, setStableState] = useState<ReplayStableState>(INITIAL_STABLE_STATE);
  const [overlayState, setOverlayState] = useState<ReplayOverlayState>(EMPTY_OVERLAY_STATE);
  const [pkg, setPkg] = useState<RecordingPackageV1 | null>(null);
  const [mediaBlob, setMediaBlob] = useState<Blob | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [volume, setVolume] = useState(100);
  const [muted, setMuted] = useState(false);
  const pointerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shortcutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearOverlayTimers = useCallback(() => {
    if (pointerTimerRef.current) clearTimeout(pointerTimerRef.current);
    if (shortcutTimerRef.current) clearTimeout(shortcutTimerRef.current);
  }, []);
  const scheduler = useMemo(() => {
    return createReplayScheduler({
      clock: createTimelineClock(),
      tickStrategy: defaultTickStrategy(),
      onTick: (state, transientEvents = []) => {
        setStableState(state);
        setOverlayState((current) => overlayStateFromEvents(current, transientEvents));
        scheduleOverlayCleanup(transientEvents, setOverlayState, pointerTimerRef, shortcutTimerRef);
      },
    });
  }, []);

  useEffect(() => scheduler.subscribe(setSchedulerState), [scheduler]);
  useEffect(() => clearOverlayTimers, [clearOverlayTimers]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      const result = await repository.load(id);
      if (cancelled) return;
      if (!result.ok) {
        setLoadError(
          `${result.error.code}: ${"message" in result.error ? result.error.message : ""}`,
        );
        return;
      }
      setPkg(result.package);
      setMediaBlob(result.mediaBlob);
      await scheduler.load(result.package);
    })();
    return () => {
      cancelled = true;
      scheduler.destroy();
    };
  }, [id, repository, scheduler]);

  if (loadError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <p className="text-sm text-danger">加载失败：{loadError}</p>
        <Link to="/" className="text-xs text-muted underline underline-offset-2">
          返回库
        </Link>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="grid flex-1 grid-cols-1 md:grid-cols-[1fr_minmax(320px,420px)]">
        <div className="relative border-r border-border">
          <CodeEditor
            language={stableState.editor.language}
            initialValue={stableState.editor.code}
            value={stableState.editor.code}
            fontSize={stableState.editor.fontSize}
            theme={stableState.editor.theme}
            readOnly
            cursor={stableState.editor.cursor}
            selection={stableState.editor.selection}
            scrollTop={stableState.editor.scrollTop}
            scrollLeft={stableState.editor.scrollLeft}
          />
          <ReplayVisualOverlays state={overlayState} />
          <RecordedMediaOverlay
            media={pkg?.media ?? null}
            mediaBlob={mediaBlob}
            mediaState={stableState.media}
            schedulerState={schedulerState}
            volume={volume}
            muted={muted}
          />
        </div>
        <div className="flex min-h-0 flex-col">
          <PreviewPane runtime={runtime} previewHtml={stableState.runtime.previewHtml} className="min-h-0 flex-1" />
          <RuntimeOutputPanel runtime={stableState.runtime} />
        </div>
      </div>
      <ReplayControls
        state={schedulerState}
        durationMs={pkg?.meta.durationMs ?? 0}
        onPlayPause={() =>
          schedulerState.status === "playing" ? scheduler.pause() : scheduler.play()
        }
        onPlay={() => scheduler.play()}
        onSeek={(target) => scheduler.seek(target)}
        onRate={(rate) => scheduler.setRate(rate)}
        volume={volume}
        muted={muted}
        onVolume={(v) => {
          setVolume(v);
          scheduler.setVolume(v);
        }}
        onMuted={(m) => {
          setMuted(m);
          scheduler.setMuted(m);
        }}
      />
    </div>
  );
}

function overlayStateFromEvents(
  current: ReplayOverlayState,
  transientEvents: RecordingEvent[],
): ReplayOverlayState {
  let next = current;
  for (const event of transientEvents) {
    if (event.type === "mouse-move" || event.type === "mouse-click") {
      const { x, y, containerWidth, containerHeight } = event.payload;
      next = {
        ...next,
        pointer: {
          id: event.id,
          xPercent: containerWidth > 0 ? (x / containerWidth) * 100 : 0,
          yPercent: containerHeight > 0 ? (y / containerHeight) * 100 : 0,
          clicked: event.type === "mouse-click",
        },
      };
    }
    if (event.type === "shortcut") {
      next = {
        ...next,
        shortcut: {
          id: event.id,
          label: event.payload.label,
        },
      };
    }
  }
  return next;
}

function scheduleOverlayCleanup(
  transientEvents: RecordingEvent[],
  setOverlayState: Dispatch<SetStateAction<ReplayOverlayState>>,
  pointerTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>,
  shortcutTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>,
) {
  const hasPointer = transientEvents.some((event) => event.type === "mouse-move" || event.type === "mouse-click");
  const hasShortcut = transientEvents.some((event) => event.type === "shortcut");
  if (hasPointer) {
    if (pointerTimerRef.current) clearTimeout(pointerTimerRef.current);
    pointerTimerRef.current = setTimeout(() => {
      setOverlayState((current) => ({ ...current, pointer: null }));
    }, TRANSIENT_OVERLAY_TTL_MS);
  }
  if (hasShortcut) {
    if (shortcutTimerRef.current) clearTimeout(shortcutTimerRef.current);
    shortcutTimerRef.current = setTimeout(() => {
      setOverlayState((current) => ({ ...current, shortcut: null }));
    }, TRANSIENT_OVERLAY_TTL_MS);
  }
}

function ReplayVisualOverlays({ state }: { state: ReplayOverlayState }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-40 overflow-hidden">
      {state.pointer ? (
        <div
          aria-label="回放鼠标位置"
          className="absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-primary/20 shadow-[0_0_24px_var(--ct-color-primary)]"
          style={{ left: `${state.pointer.xPercent}%`, top: `${state.pointer.yPercent}%` }}
        >
          {state.pointer.clicked ? (
            <span className="absolute inset-[-10px] rounded-full border border-primary/70 animate-ping" />
          ) : null}
        </div>
      ) : null}
      {state.shortcut ? (
        <div className="absolute bottom-4 right-4 rounded-md border border-border bg-popover px-3 py-2 font-mono text-sm text-popover-foreground shadow-elevation-2">
          {state.shortcut.label}
        </div>
      ) : null}
    </div>
  );
}

function RecordedMediaOverlay({
  media,
  mediaBlob,
  mediaState,
  schedulerState,
  volume,
  muted,
}: {
  media: RecordingPackageV1["media"];
  mediaBlob: Blob | null;
  mediaState: ReplayStableState["media"];
  schedulerState: ReplaySchedulerState;
  volume: number;
  muted: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const hasMedia = Boolean(media && mediaBlob);
  const hasCamera = Boolean(media?.hasCamera);
  const showCamera = hasMedia && hasCamera && mediaState.cameraEnabled;
  const mediaAdapter = useMemo(() => {
    if (!media) return null;
    return createMediaClockAdapter({
      segments: [
        {
          blobId: media.blobId,
          timelineStartMs: media.timelineOffsetMs,
          timelineEndMs: media.timelineOffsetMs + media.durationMs,
          mediaStartMs: 0,
          mediaEndMs: media.durationMs,
        },
      ],
      seekHandler: (_segment, mediaTimeMs) => {
        const video = videoRef.current;
        if (!video) return;
        video.currentTime = mediaTimeMs / 1000;
      },
      rateHandler: (rate) => {
        if (videoRef.current) videoRef.current.playbackRate = rate;
      },
    });
  }, [media]);

  useEffect(() => {
    if (!mediaBlob || typeof URL.createObjectURL !== "function") {
      setSrc(null);
      return undefined;
    }
    const url = URL.createObjectURL(mediaBlob);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [mediaBlob]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = Math.max(0, Math.min(volume, 100)) / 100;
    video.muted = muted;
  }, [volume, muted]);

  useEffect(() => {
    mediaAdapter?.setRate(schedulerState.playbackRate);
  }, [mediaAdapter, schedulerState.playbackRate]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !mediaAdapter) return;
    const targetMs = mediaAdapter.timelineToMediaTime(schedulerState.timelineTimeMs);
    if (targetMs !== null && Math.abs(video.currentTime * 1000 - targetMs) > MEDIA_DRIFT_THRESHOLD_MS) {
      video.currentTime = targetMs / 1000;
    }
    if (schedulerState.status === "playing") {
      void video.play().catch(() => undefined);
    } else {
      video.pause();
    }
  }, [mediaAdapter, schedulerState.status, schedulerState.timelineTimeMs]);

  if (!src || !hasMedia) return null;

  const style = {
    left: `${mediaState.cameraPosition.x * 100}%`,
    top: `${mediaState.cameraPosition.y * 100}%`,
    transform: `translate(-${mediaState.cameraPosition.x * 100}%, -${mediaState.cameraPosition.y * 100}%)`,
  };

  return (
    <div
      className={
        showCamera
          ? "pointer-events-none absolute z-30 h-32 w-32 overflow-hidden rounded-full border border-border bg-surface-raised shadow-elevation-2"
          : "sr-only"
      }
      style={showCamera ? style : undefined}
    >
      <video
        ref={videoRef}
        aria-label={hasCamera ? "录制摄像头视频" : "录制音频"}
        src={src}
        className="h-full w-full object-cover"
        playsInline
      />
    </div>
  );
}

function RuntimeOutputPanel({ runtime }: { runtime: ReplayStableState["runtime"] }) {
  const hasOutput = runtime.stdout.length > 0 || runtime.stderr.length > 0 || runtime.errorMessage;

  return (
    <section className="border-t border-border bg-background px-4 py-3" aria-label="Runtime output">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Console</h2>
        <span className="rounded-sm border border-border px-2 py-0.5 text-[11px] font-medium text-muted">
          {runtime.status}
        </span>
      </div>
      {hasOutput ? (
        <div className="max-h-40 space-y-2 overflow-auto font-mono text-xs leading-5">
          {runtime.stdout.map((line, index) => (
            <pre key={`stdout-${index}`} className="whitespace-pre-wrap text-foreground">
              {line}
            </pre>
          ))}
          {runtime.stderr.map((line, index) => (
            <pre key={`stderr-${index}`} className="whitespace-pre-wrap text-warning">
              {line}
            </pre>
          ))}
          {runtime.errorMessage ? (
            <pre className="whitespace-pre-wrap text-danger">{runtime.errorMessage}</pre>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-muted">No output</p>
      )}
    </section>
  );
}
