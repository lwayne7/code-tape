import { describe, expect, it, vi } from "vitest";
import { createMediaClockAdapter } from "../mediaClockAdapter";
import type { MediaTimelineSegment } from "@/shared/recording-schema";

describe("createMediaClockAdapter", () => {
  const segments: MediaTimelineSegment[] = [
    { blobId: "a", timelineStartMs: 0, timelineEndMs: 1000, mediaStartMs: 0, mediaEndMs: 1000 },
    { blobId: "b", timelineStartMs: 1500, timelineEndMs: 2500, mediaStartMs: 1000, mediaEndMs: 2000 },
  ];

  it("maps timeline → media linearly inside a segment", () => {
    const adapter = createMediaClockAdapter({ segments });
    expect(adapter.timelineToMediaTime(500)).toBe(500);
    expect(adapter.timelineToMediaTime(1800)).toBe(1300);
  });

  it("returns null in the gap between segments (pause island)", () => {
    const adapter = createMediaClockAdapter({ segments });
    expect(adapter.timelineToMediaTime(1200)).toBeNull();
  });

  it("maps media → timeline inversely", () => {
    const adapter = createMediaClockAdapter({ segments });
    expect(adapter.mediaToTimelineTime(0.5)).toBe(500);
    expect(adapter.mediaToTimelineTime(1.3)).toBe(1800);
  });

  it("delegates seek to seekHandler with the right segment + media time", async () => {
    const seek = vi.fn();
    const adapter = createMediaClockAdapter({ segments, seekHandler: seek });
    await adapter.seek(1800);
    expect(seek).toHaveBeenCalledWith(segments[1], 1300);
  });

  it("holds seek until metadata is ready, then flushes the pending media time", async () => {
    let metadataReady = false;
    const seek = vi.fn();
    const adapter = createMediaClockAdapter({
      segments,
      seekHandler: seek,
      metadataReadyProvider: () => metadataReady,
    });

    await adapter.seek(1800);
    expect(seek).not.toHaveBeenCalled();

    metadataReady = true;
    await adapter.flushPendingSeek();

    expect(seek).toHaveBeenCalledWith(segments[1], 1300);
  });

  it("does not flush the same pending seek twice while an async seek is in flight", async () => {
    let metadataReady = false;
    let resolveSeek!: () => void;
    const seek = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSeek = resolve;
        }),
    );
    const adapter = createMediaClockAdapter({
      segments,
      seekHandler: seek,
      metadataReadyProvider: () => metadataReady,
    });

    await adapter.seek(1800);
    metadataReady = true;
    const firstFlush = adapter.flushPendingSeek();
    const secondFlush = adapter.flushPendingSeek();

    expect(seek).toHaveBeenCalledTimes(1);
    resolveSeek();
    await Promise.all([firstFlush, secondFlush]);
  });

  it("cancels a pending seek when the latest seek lands outside media segments", async () => {
    let metadataReady = false;
    const seek = vi.fn();
    const adapter = createMediaClockAdapter({
      segments,
      seekHandler: seek,
      metadataReadyProvider: () => metadataReady,
    });

    await adapter.seek(500);
    await adapter.seek(1200);
    metadataReady = true;
    await adapter.flushPendingSeek();

    expect(seek).not.toHaveBeenCalled();
  });
});
