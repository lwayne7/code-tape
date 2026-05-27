import { cloneState } from "@/features/player/initialState";
import { replayReducer, STABLE_EVENT_TYPES } from "@/features/player/replayReducer";
import type {
  RecordingEvent,
  RecordingSnapshot,
  RecordStartPayload,
  ReplayStableState,
} from "@/shared/recording-schema";
import { generateId } from "@/shared/util/ids";

const PERIODIC_SNAPSHOT_MS = 5_000;
const STABLE_EVENTS_PER_SNAPSHOT = 50;
const SEMANTIC_SNAPSHOT_TYPES = new Set<RecordingEvent["type"]>([
  "record-pause",
  "record-resume",
  "language-change",
  "run-start",
  "run-output",
  "run-error",
]);

export type SnapshotBuilder = {
  apply(event: RecordingEvent): void;
  getSnapshots(): RecordingSnapshot[];
  finalize(): RecordingSnapshot[];
  reset(): void;
};

export function createSnapshotBuilder(): SnapshotBuilder {
  let state: ReplayStableState | null = null;
  let lastEvent: RecordingEvent | null = null;
  let lastSnapshotTimestampMs = -Infinity;
  let lastSnapshotSeq = 0;
  let stableEventsSinceSnapshot = 0;
  const snapshots: RecordingSnapshot[] = [];

  const capture = (event: RecordingEvent) => {
    if (!state || lastSnapshotSeq === event.seq) return;
    snapshots.push({
      id: generateId("snap"),
      timestampMs: event.timestampMs,
      eventSeq: event.seq,
      state: cloneState(state),
    });
    lastSnapshotTimestampMs = event.timestampMs;
    lastSnapshotSeq = event.seq;
    stableEventsSinceSnapshot = 0;
  };
  const getSnapshots = () =>
    snapshots.map((snapshot) => ({
      ...snapshot,
      state: cloneState(snapshot.state),
    }));

  return {
    apply(event) {
      lastEvent = event;
      if (event.type === "record-start") {
        state = initialStateFromRecordStart(event.payload);
        capture(event);
        return;
      }
      if (!state) return;

      if (STABLE_EVENT_TYPES.has(event.type)) {
        state = replayReducer(state, event);
        stableEventsSinceSnapshot += 1;
      }

      if (
        event.timestampMs - lastSnapshotTimestampMs >= PERIODIC_SNAPSHOT_MS ||
        stableEventsSinceSnapshot >= STABLE_EVENTS_PER_SNAPSHOT ||
        SEMANTIC_SNAPSHOT_TYPES.has(event.type)
      ) {
        capture(event);
      }
    },
    getSnapshots() {
      return getSnapshots();
    },
    finalize() {
      if (lastEvent) capture(lastEvent);
      return getSnapshots();
    },
    reset() {
      state = null;
      lastEvent = null;
      lastSnapshotTimestampMs = -Infinity;
      lastSnapshotSeq = 0;
      stableEventsSinceSnapshot = 0;
      snapshots.length = 0;
    },
  };
}

function initialStateFromRecordStart(payload: RecordStartPayload): ReplayStableState {
  return {
    editor: {
      code: "",
      language: payload.initialLanguage,
      cursor: null,
      selection: null,
      scrollTop: 0,
      scrollLeft: 0,
      fontSize: payload.initialFontSize,
      theme: payload.initialTheme,
    },
    pointer: null,
    media: {
      microphoneEnabled: false,
      cameraEnabled: false,
      cameraPosition: { x: 0, y: 0 },
    },
    runtime: {
      status: "idle",
      stdout: [],
      stderr: [],
      previewHtml: null,
      errorMessage: null,
    },
  };
}
