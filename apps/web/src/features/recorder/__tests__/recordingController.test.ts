import { describe, expect, it, vi } from "vitest";
import { createRecordingClock } from "../recordingClock";
import { createEventBus } from "../eventBus";
import { createPackageBuilder } from "../packageBuilder";
import { createRecordingController } from "../recordingController";
import type {
  EventProducer,
  PackageBuildInput,
  RecordingPackageV1,
  RecordingRepository,
  RecordStartPayload,
  SaveDraftInput,
} from "@/shared/recording-schema";

function makeProducer(name: string): EventProducer & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    start: () => calls.push(`${name}:start`),
    pause: () => calls.push(`${name}:pause`),
    resume: () => calls.push(`${name}:resume`),
    stop: () => calls.push(`${name}:stop`),
    dispose: () => calls.push(`${name}:dispose`),
  };
}

function makeRepository(): RecordingRepository & {
  drafts: SaveDraftInput[];
  commits: string[];
} {
  const drafts: SaveDraftInput[] = [];
  const commits: string[] = [];
  return {
    drafts,
    commits,
    saveDraft: vi.fn(async (input: SaveDraftInput) => {
      drafts.push(input);
      return { ok: true as const, recordingId: input.meta.id };
    }),
    commit: vi.fn(async (id: string) => {
      commits.push(id);
      return { ok: true as const, recordingId: id };
    }),
    list: vi.fn(async () => []),
    load: vi.fn(async () => ({ ok: false as const, error: { code: "incomplete-package" as const, packageId: "x" } })),
    rename: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    exportZip: vi.fn(async () => new Blob()),
    importZip: vi.fn(async () => ({ ok: true as const, recordingId: "x" })),
    sweep: vi.fn(async () => ({ removedDrafts: 0, removedBlobs: 0 })),
    estimateQuota: vi.fn(async () => ({ usageBytes: 0, quotaBytes: 0 })),
  };
}

function makeStartPayload(): RecordStartPayload {
  return {
    initialLanguage: "javascript",
    initialTheme: "dark",
    initialFontSize: 14,
    selectedAudioDeviceId: null,
    selectedCameraDeviceId: null,
    mediaCapability: {
      audio: "available",
      camera: "available",
      selectedAudioDeviceId: null,
      selectedCameraDeviceId: null,
    },
  };
}

function setup(
  options: {
    mediaSource?: () => Promise<PackageBuildInput["media"]>;
    onPersistenceFailure?: Parameters<typeof createRecordingController>[0]["onPersistenceFailure"];
  } = {},
) {
  let wall = 1_000;
  const clock = createRecordingClock({ nowProvider: () => wall });
  const bus = createEventBus({ clock, wallTimeProvider: () => "T" });
  const producers = [makeProducer("p1"), makeProducer("p2")];
  const repository = makeRepository();
  const controller = createRecordingController({
    clock,
    bus,
    producers,
    packageBuilder: createPackageBuilder(),
    repository,
    appVersion: "0.0.0",
    generateTitle: () => "title-x",
    mediaSource: options.mediaSource,
    onPersistenceFailure: options.onPersistenceFailure,
  });
  return {
    controller,
    bus,
    producers,
    repository,
    advance: (ms: number) => {
      wall += ms;
    },
  };
}

describe("createRecordingController", () => {
  it("idle → recording → paused → recording → stopping → completed", async () => {
    const { controller, advance } = setup();
    const states: string[] = [];
    controller.subscribe((s) => states.push(s.status));

    await controller.start(makeStartPayload());
    advance(500);
    controller.pause();
    advance(2000);
    await controller.resume();
    advance(500);
    const pkg: RecordingPackageV1 = await controller.stop("user");

    expect(controller.state.status).toBe("completed");
    expect(states).toContain("recording");
    expect(states).toContain("paused");
    expect(states).toContain("processing");
    expect(states).toContain("completed");
    expect(pkg.meta.title).toBe("title-x");
    expect(pkg.meta.durationMs).toBe(1000);
  });

  it("emits record-start / record-pause / record-resume / record-stop in order", async () => {
    const { controller, bus, advance } = setup();
    const seen: string[] = [];
    bus.subscribe((event) => seen.push(event.type));

    await controller.start(makeStartPayload());
    advance(100);
    controller.pause();
    await controller.resume();
    await controller.stop("user");

    expect(seen[0]).toBe("record-start");
    expect(seen).toContain("record-pause");
    expect(seen).toContain("record-resume");
    expect(seen.at(-1)).toBe("record-stop");
  });

  it("propagates lifecycle calls to every producer", async () => {
    const { controller, producers } = setup();
    await controller.start(makeStartPayload());
    controller.pause();
    await controller.resume();
    await controller.stop("user");
    expect(producers[0].calls).toContain("p1:start");
    expect(producers[0].calls).toContain("p1:stop");
    expect(producers[1].calls).toContain("p2:resume");
  });

  it("saveDraft + commit are both invoked on successful stop", async () => {
    const { controller, repository } = setup();
    await controller.start(makeStartPayload());
    await controller.stop("user");
    expect(repository.drafts.length).toBe(1);
    expect(repository.commits.length).toBe(1);
  });

  it("includes finalized media from mediaSource in the saved package", async () => {
    const mediaBlob = new Blob(["media"], { type: "video/webm" });
    const mediaSource = vi.fn(async () => ({
      blob: mediaBlob,
      durationMs: 1_500,
      mimeType: "video/webm",
      hasAudio: true,
      hasCamera: true,
    }));
    const { controller, repository } = setup({ mediaSource });

    await controller.start(makeStartPayload());
    const pkg = await controller.stop("user");

    expect(mediaSource).toHaveBeenCalledTimes(1);
    expect(pkg.media).toEqual(
      expect.objectContaining({
        durationMs: 1_500,
        mimeType: "video/webm",
        hasAudio: true,
        hasCamera: true,
      }),
    );
    expect(repository.drafts[0].mediaBlob).toBe(mediaBlob);
  });

  it("saves the package without media when mediaSource fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mediaSource = vi.fn(async () => {
      throw new Error("InvalidStateError");
    });
    const { controller, repository } = setup({ mediaSource });

    await controller.start(makeStartPayload());
    const pkg = await controller.stop("user");

    expect(mediaSource).toHaveBeenCalledTimes(1);
    expect(pkg.media).toBeNull();
    expect(repository.drafts[0].mediaBlob).toBeNull();
    expect(controller.state.status).toBe("completed");
    warn.mockRestore();
  });

  it("does not complete when saveDraft fails", async () => {
    const { controller, repository } = setup();
    vi.mocked(repository.saveDraft).mockResolvedValueOnce({
      ok: false,
      reason: "quota-exceeded",
      message: "IndexedDB quota exceeded",
    });

    await controller.start(makeStartPayload());
    await expect(controller.stop("user")).rejects.toThrow(/save-draft-failed/);

    expect(controller.state.status).toBe("failed");
    expect(controller.state.lastError?.code).toBe("save-draft-failed");
    expect(repository.commits.length).toBe(0);
  });

  it("passes the finalized package to the persistence failure fallback", async () => {
    const onPersistenceFailure = vi.fn();
    const { controller, repository } = setup({ onPersistenceFailure });
    vi.mocked(repository.saveDraft).mockResolvedValueOnce({
      ok: false,
      reason: "quota-exceeded",
      message: "IndexedDB quota exceeded",
    });

    await controller.start(makeStartPayload());
    await expect(controller.stop("user")).rejects.toThrow(/save-draft-failed/);

    expect(onPersistenceFailure).toHaveBeenCalledTimes(1);
    expect(onPersistenceFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaBlob: null,
        pkg: expect.objectContaining({
          meta: expect.objectContaining({ title: "title-x" }),
        }),
        error: expect.any(Error),
      }),
    );
  });

  it("reuses finalized media when saveDraft fails and stop is retried", async () => {
    const mediaBlob = new Blob(["media"], { type: "video/webm" });
    const mediaSource = vi.fn(async () => ({
      blob: mediaBlob,
      durationMs: 1_500,
      mimeType: "video/webm",
      hasAudio: true,
      hasCamera: true,
    }));
    const { controller, repository } = setup({ mediaSource });
    vi.mocked(repository.saveDraft).mockResolvedValueOnce({
      ok: false,
      reason: "quota-exceeded",
      message: "IndexedDB quota exceeded",
    });

    await controller.start(makeStartPayload());
    await expect(controller.stop("user")).rejects.toThrow(/save-draft-failed/);
    const pkg = await controller.stop("user");

    expect(mediaSource).toHaveBeenCalledTimes(1);
    expect(repository.saveDraft).toHaveBeenCalledTimes(2);
    expect(vi.mocked(repository.saveDraft).mock.calls[0][0].mediaBlob).toBe(mediaBlob);
    expect(vi.mocked(repository.saveDraft).mock.calls[1][0].mediaBlob).toBe(mediaBlob);
    expect(repository.drafts).toHaveLength(1);
    expect(repository.drafts[0].mediaBlob).toBe(mediaBlob);
    expect(pkg.media).toEqual(
      expect.objectContaining({
        durationMs: 1_500,
        mimeType: "video/webm",
      }),
    );
    expect(controller.state.status).toBe("completed");
  });

  it("does not complete when commit fails", async () => {
    const { controller, repository } = setup();
    vi.mocked(repository.commit).mockResolvedValueOnce({
      ok: false,
      reason: "validation-failed",
      message: "draft not found",
    });

    await controller.start(makeStartPayload());
    await expect(controller.stop("user")).rejects.toThrow(/commit-failed/);

    expect(controller.state.status).toBe("failed");
    expect(controller.state.lastError?.code).toBe("commit-failed");
  });

  it("reset returns the controller to idle and disposes producers", async () => {
    const { controller, producers } = setup();
    await controller.start(makeStartPayload());
    controller.reset();
    expect(controller.state.status).toBe("idle");
    expect(producers[0].calls).toContain("p1:stop");
    expect(producers[0].calls).toContain("p1:dispose");
  });
});
