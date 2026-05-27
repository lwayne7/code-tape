import type {
  MediaClockAdapter,
  MediaTimelineSegment,
  ReplaySchedulerState,
} from "@/shared/recording-schema";

export type MediaClockAdapterOptions = {
  segments: MediaTimelineSegment[];
  /** Seek the underlying HTMLMediaElement; receives mediaTime in ms. */
  seekHandler?: (segment: MediaTimelineSegment, mediaTimeMs: number) => Promise<void> | void;
  /** Adjust playback rate of the underlying HTMLMediaElement. */
  rateHandler?: (rate: number) => void;
  /** Read the underlying HTMLMediaElement currentTime in seconds. */
  currentTimeProvider?: () => number | null;
  /** True when assigning HTMLMediaElement.currentTime is valid. */
  metadataReadyProvider?: () => boolean;
  /** Surface the media element loading/buffering/error status to the scheduler. */
  statusProvider?: () => ReplaySchedulerState["mediaStatus"];
};

export type ReplayMediaClockAdapter = MediaClockAdapter & {
  getStatus(): ReplaySchedulerState["mediaStatus"];
  getCurrentTimeSec(): number | null;
  flushPendingSeek(): Promise<void>;
};

/**
 * MediaClockAdapter — bidirectional mapping between the recording's "effective"
 * timeline (which excludes paused intervals) and one or more media segments
 * (which are real wall-time WebM blobs concatenated).
 *
 * For P0, recordings typically have exactly one segment. The adapter still
 * accepts multiple segments so a future "concat pause islands" optimization
 * doesn't require an interface bump.
 */
export function createMediaClockAdapter(options: MediaClockAdapterOptions): ReplayMediaClockAdapter {
  const segments = options.segments.slice().sort((a, b) => a.timelineStartMs - b.timelineStartMs);
  let seekGeneration = 0;
  let pendingSeek: {
    segment: MediaTimelineSegment;
    mediaTimeMs: number;
    generation: number;
  } | null = null;

  const findSegmentForTimeline = (targetMs: number): MediaTimelineSegment | null => {
    let lo = 0;
    let hi = segments.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const seg = segments[mid];
      if (targetMs < seg.timelineStartMs) hi = mid - 1;
      else if (targetMs > seg.timelineEndMs) lo = mid + 1;
      else return seg;
    }
    return null;
  };

  const metadataReady = () => options.metadataReadyProvider?.() ?? true;
  const runSeek = async (segment: MediaTimelineSegment, mediaTimeMs: number) => {
    await options.seekHandler?.(segment, mediaTimeMs);
  };

  return {
    segments,
    timelineToMediaTime(targetMs) {
      const seg = findSegmentForTimeline(targetMs);
      if (!seg) return null;
      return seg.mediaStartMs + (targetMs - seg.timelineStartMs);
    },
    mediaToTimelineTime(mediaCurrentTimeSec) {
      const mediaMs = mediaCurrentTimeSec * 1000;
      for (const seg of segments) {
        if (mediaMs >= seg.mediaStartMs && mediaMs <= seg.mediaEndMs) {
          return seg.timelineStartMs + (mediaMs - seg.mediaStartMs);
        }
      }
      return null;
    },
    async seek(targetMs) {
      seekGeneration += 1;
      const seg = findSegmentForTimeline(targetMs);
      if (!seg) {
        pendingSeek = null;
        return;
      }
      const mediaTimeMs = seg.mediaStartMs + (targetMs - seg.timelineStartMs);
      if (!metadataReady()) {
        pendingSeek = { segment: seg, mediaTimeMs, generation: seekGeneration };
        return;
      }
      pendingSeek = null;
      await runSeek(seg, mediaTimeMs);
    },
    setRate(rate) {
      options.rateHandler?.(rate);
    },
    getStatus() {
      if (options.statusProvider) return options.statusProvider();
      if (segments.length === 0) return "missing";
      return metadataReady() ? "ready" : "loading";
    },
    getCurrentTimeSec() {
      return options.currentTimeProvider?.() ?? null;
    },
    async flushPendingSeek() {
      if (!pendingSeek || !metadataReady()) return;
      const currentPending = pendingSeek;
      pendingSeek = null;
      try {
        await runSeek(currentPending.segment, currentPending.mediaTimeMs);
      } catch (error) {
        if (pendingSeek === null && seekGeneration === currentPending.generation) {
          pendingSeek = currentPending;
        }
        throw error;
      }
    },
  };
}
