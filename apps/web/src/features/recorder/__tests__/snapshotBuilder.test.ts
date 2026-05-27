import { describe, expect, it } from "vitest";
import { createSnapshotBuilder } from "../snapshotBuilder";
import type { RecordingEvent, RecordStartPayload } from "@/shared/recording-schema";

const START_PAYLOAD: RecordStartPayload = {
  initialLanguage: "javascript",
  initialTheme: "dark",
  initialFontSize: 14,
  selectedAudioDeviceId: "mic-1",
  selectedCameraDeviceId: "cam-1",
  mediaCapability: {
    audio: "available",
    camera: "available",
    selectedAudioDeviceId: "mic-1",
    selectedCameraDeviceId: "cam-1",
  },
};

function event<TType extends RecordingEvent["type"]>(
  seq: number,
  timestampMs: number,
  type: TType,
  payload: Extract<RecordingEvent, { type: TType }>["payload"],
): Extract<RecordingEvent, { type: TType }> {
  return {
    id: `e-${seq}`,
    seq,
    timestampMs,
    wallTime: "T",
    source: sourceFor(type),
    track: trackFor(type),
    type,
    payload,
  } as Extract<RecordingEvent, { type: TType }>;
}

function content(seq: number, timestampMs: number): RecordingEvent {
  return event(seq, timestampMs, "content-change", {
    fileId: "main",
    version: seq,
    code: `console.log(${seq});`,
    contentHash: `hash-${seq}`,
    language: "javascript",
    changeReason: "input",
    changeCount: 1,
    flushedBy: "debounce",
  });
}

describe("createSnapshotBuilder", () => {
  it("captures initial, periodic, stable-count, semantic, and final inclusive snapshots", () => {
    const builder = createSnapshotBuilder();

    builder.apply(event(1, 0, "record-start", START_PAYLOAD));
    expect(builder.getSnapshots()).toMatchObject([
      {
        timestampMs: 0,
        eventSeq: 1,
        state: { editor: { language: "javascript", fontSize: 14, theme: "dark" } },
      },
    ]);

    for (let seq = 2; seq <= 50; seq += 1) {
      builder.apply(content(seq, 1_000));
    }
    expect(builder.getSnapshots()).toHaveLength(1);

    builder.apply(content(51, 1_000));
    builder.apply(content(52, 6_000));
    builder.apply(event(53, 6_100, "record-pause", { reason: "user", stateSeq: 52 }));
    builder.apply(event(54, 6_200, "record-resume", { reason: "user" }));
    builder.apply(event(55, 6_300, "run-start", {
      language: "javascript",
      runtime: "iframe",
      runId: "run-1",
    }));
    builder.apply(event(56, 6_400, "run-output", {
      runId: "run-1",
      stdout: ["ok"],
      stderr: [],
      previewHtml: "<body>ok</body>",
      status: "success",
    }));
    builder.apply(event(57, 6_500, "media-toggle", {
      microphoneEnabled: true,
      cameraEnabled: true,
    }));
    builder.apply(event(58, 6_600, "camera-position", { x: 0.8, y: 0.75 }));
    builder.apply(event(59, 7_000, "record-stop", { durationMs: 7_000, reason: "user" }));

    const snapshots = builder.finalize();

    expect(snapshots.map((snapshot) => snapshot.eventSeq)).toEqual([
      1,
      51,
      52,
      53,
      54,
      55,
      56,
      59,
    ]);
    expect(snapshots.at(-1)).toMatchObject({
      timestampMs: 7_000,
      eventSeq: 59,
      state: {
        media: {
          microphoneEnabled: true,
          cameraEnabled: true,
          cameraPosition: { x: 0.8, y: 0.75 },
        },
        runtime: {
          status: "success",
          stdout: ["ok"],
          previewHtml: "<body>ok</body>",
        },
      },
    });
  });
});

function sourceFor(type: RecordingEvent["type"]): RecordingEvent["source"] {
  if (type.startsWith("record")) return "recorder";
  if (type === "content-change" || type === "language-change") return "editor";
  if (type === "media-toggle" || type === "camera-position") return "media";
  if (type.startsWith("run")) return "runtime";
  return "recorder";
}

function trackFor(type: RecordingEvent["type"]): RecordingEvent["track"] {
  if (type === "media-toggle") return "media";
  if (type === "camera-position") return "ui";
  if (type.startsWith("run")) return "runtime";
  return "main";
}
