import { describe, expect, it, vi } from "vitest";
import { createRecordingClock } from "../recordingClock";
import { createEventBus } from "../eventBus";
import { createPackageBuilder } from "../packageBuilder";
import { createRecordingController } from "../recordingController";
import type {
  EventProducer,
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

function setup() {
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

  it("reset returns the controller to idle and disposes producers", async () => {
    const { controller, producers } = setup();
    await controller.start(makeStartPayload());
    controller.reset();
    expect(controller.state.status).toBe("idle");
    expect(producers[0].calls).toContain("p1:dispose");
  });
});
