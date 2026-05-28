import { Captions, Loader2, WandSparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createSubtitleStore } from "./subtitleStore";
import { createHuggingFaceSubtitleTranscriber } from "./subtitleTranscriber";
import type { SubtitleSegment, SubtitleStore, SubtitleTrack, SubtitleTranscriber } from "./types";
import { cn } from "@/shared/ui/utils/cn";

export type SubtitlePanelProps = {
  recordingId: string | null;
  mediaBlob: Blob | null;
  hasAudio: boolean;
  durationMs: number;
  currentTimeMs: number;
  onSeek(timeMs: number): void;
  store?: SubtitleStore;
  transcriber?: SubtitleTranscriber;
};

type GenerationStatus = "idle" | "loading" | "generating" | "ready" | "error";

export function SubtitlePanel({
  recordingId,
  mediaBlob,
  hasAudio,
  durationMs,
  currentTimeMs,
  onSeek,
  store: injectedStore,
  transcriber: injectedTranscriber,
}: SubtitlePanelProps) {
  const store = useMemo(() => injectedStore ?? createSubtitleStore(), [injectedStore]);
  const transcriber = useMemo(
    () => injectedTranscriber ?? createHuggingFaceSubtitleTranscriber(),
    [injectedTranscriber],
  );
  const [track, setTrack] = useState<SubtitleTrack | null>(null);
  const [status, setStatus] = useState<GenerationStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const activeSegment = findActiveSegment(track?.segments ?? [], currentTimeMs);
  const activeSegmentRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!recordingId) {
      setTrack(null);
      setStatus("idle");
      return;
    }
    let cancelled = false;
    setTrack(null);
    setStatus("loading");
    setError(null);
    store
      .load(recordingId)
      .then((savedTrack) => {
        if (cancelled) return;
        setTrack(savedTrack);
        setStatus(savedTrack ? "ready" : "idle");
      })
      .catch((err) => {
        if (cancelled) return;
        setError(formatSubtitleError(err));
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [recordingId, store]);

  useEffect(() => {
    activeSegmentRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [activeSegment?.id]);

  const canGenerate = Boolean(recordingId && mediaBlob && hasAudio && status !== "generating");
  const generateSubtitles = async () => {
    if (!recordingId || !mediaBlob || !hasAudio) return;
    setStatus("generating");
    setError(null);
    try {
      const draft = await transcriber.transcribe({ mediaBlob, durationMs });
      const nextTrack: SubtitleTrack = {
        recordingId,
        generatedAt: new Date().toISOString(),
        ...draft,
      };
      await store.save(nextTrack);
      setTrack(nextTrack);
      setStatus("ready");
    } catch (err) {
      setError(formatSubtitleError(err));
      setStatus("error");
    }
  };

  return (
    <section
      aria-label="字幕"
      className="border-t border-border bg-background px-3 py-2"
    >
      <div className="mb-2 flex min-h-9 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
          <Captions aria-hidden size={17} className="shrink-0 text-primary" />
          <span>字幕</span>
          {track ? (
            <span className="truncate text-xs font-normal text-muted">{track.model}</span>
          ) : null}
        </div>
        <button
          type="button"
          aria-label="生成字幕"
          disabled={!canGenerate}
          onClick={generateSubtitles}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2 text-xs font-medium",
            "text-foreground transition-[background-color,color] duration-150 ease-out-soft",
            "hover:bg-surface disabled:cursor-not-allowed disabled:opacity-40",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          )}
        >
          {status === "generating" ? (
            <Loader2 aria-hidden size={14} className="animate-spin" />
          ) : (
            <WandSparkles aria-hidden size={14} />
          )}
          <span>生成字幕</span>
        </button>
      </div>
      {status === "error" && error ? (
        <p role="alert" className="mb-2 text-xs text-danger">
          {error}
        </p>
      ) : null}
      {!hasAudio ? (
        <p className="text-xs text-muted">无音频轨道</p>
      ) : track && track.segments.length > 0 ? (
        <div className="flex max-h-32 flex-col gap-1 overflow-auto pr-1">
          {track.segments.map((segment) => {
            const isActive = activeSegment?.id === segment.id;
            return (
              <button
                key={segment.id}
                ref={isActive ? activeSegmentRef : undefined}
                type="button"
                aria-current={isActive ? "true" : undefined}
                aria-label={segment.text}
                onClick={() => onSeek(segment.startMs)}
                className={cn(
                  "grid grid-cols-[4.5rem_1fr] gap-2 rounded-md px-2 py-1.5 text-left text-xs leading-5",
                  "transition-[background-color,color] duration-150 ease-out-soft",
                  "hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
                  isActive ? "bg-surface-raised text-foreground" : "text-muted",
                )}
              >
                <span className="font-mono tabular-nums">{formatSubtitleTime(segment.startMs)}</span>
                <span className="text-foreground">{segment.text}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="text-xs text-muted">
          {status === "generating" ? "正在生成字幕..." : "暂无字幕"}
        </p>
      )}
    </section>
  );
}

function findActiveSegment(
  segments: SubtitleSegment[],
  currentTimeMs: number,
): SubtitleSegment | null {
  return (
    segments.find((segment) => currentTimeMs >= segment.startMs && currentTimeMs < segment.endMs) ??
    null
  );
}

function formatSubtitleTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatSubtitleError(error: unknown): string {
  return error instanceof Error ? error.message : "字幕生成失败";
}
