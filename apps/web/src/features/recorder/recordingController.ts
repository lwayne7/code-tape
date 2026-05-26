import { generateId } from "@/shared/util/ids";
import type {
  EventProducer,
  PackageBuildInput,
  RecordingController,
  RecordingControllerDeps,
  RecordingControllerState,
  RecordingControllerStatus,
  RecordingPackageV1,
  RecordingSnapshot,
  RecordStartPayload,
} from "@/shared/recording-schema";

export type RecordingControllerOptions = RecordingControllerDeps & {
  appVersion: string;
  generateTitle?: () => string;
  /**
   * Optional snapshot source. When provided, the controller takes a snapshot
   * during `stop()` so packages always include at least one final snapshot.
   * The recorder's editorProducer is the natural source.
  */
  snapshotSource?: () => Promise<RecordingSnapshot | null>;
  mediaSource?: () => Promise<PackageBuildInput["media"]>;
  onPersistenceFailure?: (failure: RecordingPersistenceFailure) => void | Promise<void>;
};

const VALID_TRANSITIONS: Record<RecordingControllerStatus, RecordingControllerStatus[]> = {
  idle: ["requestingPermission", "recording", "failed"],
  requestingPermission: ["recording", "failed", "idle"],
  recording: ["paused", "stopping", "failed"],
  paused: ["recording", "stopping", "failed"],
  stopping: ["processing", "failed"],
  processing: ["completed", "failed"],
  completed: ["idle"],
  failed: ["idle", "stopping"],
};

type PendingPackageSave = { pkg: RecordingPackageV1; mediaBlob: Blob | null };
export type RecordingPersistenceFailure = PendingPackageSave & { error: unknown };

/**
 * RecordingController — central state machine that wires clock + bus + producers
 * + builder + repository.
 *
 * State transitions are strictly enforced via VALID_TRANSITIONS so callers
 * never accidentally drive the controller into impossible states. Each public
 * method does:
 *   1. transition guard
 *   2. side effects (clock + producers + bus emit)
 *   3. publish state to listeners
 *
 * Errors during any phase tear the controller down to `failed`; callers may
 * `reset()` back to `idle` after surfacing the error.
 */
export function createRecordingController(options: RecordingControllerOptions): RecordingController {
  const { clock, bus, producers, packageBuilder, repository } = options;
  const listeners = new Set<(s: RecordingControllerState) => void>();

  let state: RecordingControllerState = {
    status: "idle",
    startedAt: null,
    durationMs: 0,
    mediaCapability: {
      audio: "unsupported",
      camera: "unsupported",
      selectedAudioDeviceId: null,
      selectedCameraDeviceId: null,
    },
    lastError: null,
  };

  let startPayload: RecordStartPayload | null = null;
  let finalizedMedia: PackageBuildInput["media"] | undefined;
  let pendingPackageSave: PendingPackageSave | null = null;

  const publish = () => listeners.forEach((fn) => fn(state));
  const transitionTo = (next: RecordingControllerStatus, patch: Partial<RecordingControllerState> = {}) => {
    const allowed = VALID_TRANSITIONS[state.status] ?? [];
    if (!allowed.includes(next) && next !== state.status) {
      throw new Error(`Illegal transition: ${state.status} -> ${next}`);
    }
    state = { ...state, ...patch, status: next };
    publish();
  };

  const forEachProducer = (op: (p: EventProducer) => void): void => {
    for (const producer of producers) {
      try {
        op(producer);
      } catch (err) {
        console.warn("[recording-controller] producer threw:", err);
      }
    }
  };

  return {
    get state() {
      return state;
    },
    async start(input) {
      transitionTo("requestingPermission", { lastError: null });
      try {
        startPayload = input;
        clock.start();
        const startedAt = new Date().toISOString();
        transitionTo("recording", {
          startedAt,
          durationMs: 0,
          mediaCapability: input.mediaCapability,
        });
        bus.emit({
          type: "record-start",
          source: "recorder",
          track: "main",
          payload: input,
        });
        forEachProducer((p) => p.start());
      } catch (err) {
        transitionTo("failed", { lastError: errorToInfo(err) });
        throw err;
      }
    },
    pause() {
      if (state.status !== "recording") return;
      const seq = bus.peek().length;
      bus.emit({
        type: "record-pause",
        source: "recorder",
        track: "main",
        payload: { reason: "user", stateSeq: seq },
      });
      forEachProducer((p) => p.pause());
      clock.pause();
      transitionTo("paused", { durationMs: clock.durationMs() });
    },
    async resume() {
      if (state.status !== "paused") return;
      clock.resume();
      forEachProducer((p) => p.resume());
      bus.emit({
        type: "record-resume",
        source: "recorder",
        track: "main",
        payload: { reason: "user" },
      });
      transitionTo("recording", { durationMs: clock.durationMs() });
    },
    async stop(reason): Promise<RecordingPackageV1> {
      if (state.status === "failed" && !pendingPackageSave) {
        throw new Error("No pending recording package is available to retry.");
      }
      transitionTo("stopping", { lastError: null });
      try {
        if (!pendingPackageSave) {
          forEachProducer((p) => p.stop());
          const durationMs = clock.durationMs();
          bus.emit({
            type: "record-stop",
            source: "recorder",
            track: "main",
            payload: { durationMs, reason },
          });
          clock.stop();
          transitionTo("processing", { durationMs });

          const events = bus.drain();
          const snapshot = options.snapshotSource ? await options.snapshotSource() : null;
          const snapshots: RecordingSnapshot[] = snapshot ? [snapshot] : [];
          if (!startPayload) {
            throw new Error("RecordingController.start() must be called before stop().");
          }
          if (finalizedMedia === undefined) {
            finalizedMedia = await resolveMedia(options.mediaSource);
          }

          const titleProvider = options.generateTitle ?? (() => `录制 ${new Date().toLocaleString()}`);

          pendingPackageSave = await packageBuilder.build({
            meta: {
              id: generateId("rec"),
              title: titleProvider(),
              createdAt: state.startedAt ?? new Date().toISOString(),
              durationMs,
              appVersion: options.appVersion,
              ownerId: null,
              creatorInfo: null,
              initialLanguage: startPayload.initialLanguage,
              initialFontSize: startPayload.initialFontSize,
              initialTheme: startPayload.initialTheme,
              mediaCapability: startPayload.mediaCapability,
            },
            events,
            snapshots,
            media: finalizedMedia,
          });
        } else {
          transitionTo("processing", { durationMs: pendingPackageSave.pkg.meta.durationMs });
        }

        await persistPackage(repository, pendingPackageSave);

        transitionTo("completed");
        const pkg = pendingPackageSave.pkg;
        pendingPackageSave = null;
        finalizedMedia = undefined;
        startPayload = null;
        return pkg;
      } catch (err) {
        if (pendingPackageSave) {
          try {
            await options.onPersistenceFailure?.({ ...pendingPackageSave, error: err });
          } catch (fallbackErr) {
            console.warn("[recording-controller] persistence fallback failed:", fallbackErr);
          }
        }
        transitionTo("failed", { lastError: errorToInfo(err) });
        throw err;
      }
    },
    reset() {
      if (isActiveStatus(state.status)) {
        forEachProducer((p) => p.stop());
        clock.stop();
      }
      forEachProducer((p) => p.dispose());
      bus.reset();
      state = {
        status: "idle",
        startedAt: null,
        durationMs: 0,
        mediaCapability: state.mediaCapability,
        lastError: null,
      };
      startPayload = null;
      finalizedMedia = undefined;
      pendingPackageSave = null;
      publish();
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
  } satisfies RecordingController;
}

async function persistPackage(
  repository: RecordingControllerDeps["repository"],
  pending: PendingPackageSave,
): Promise<void> {
  const { pkg, mediaBlob } = pending;
  const saveResult = await repository.saveDraft({
    meta: pkg.meta,
    events: pkg.events,
    snapshots: pkg.snapshots,
    indexes: pkg.indexes ?? {
      generatedAt: new Date().toISOString(),
      eventsByType: {} as Record<string, number[]>,
      snapshotSeqsByTime: [],
      markers: [],
    },
    mediaBlob,
  });
  if (!saveResult.ok) {
    throw persistenceError("save-draft-failed", saveResult.reason, saveResult.message);
  }

  const commitResult = await repository.commit(pkg.meta.id);
  if (!commitResult.ok) {
    throw persistenceError("commit-failed", commitResult.reason, commitResult.message);
  }
}

function isActiveStatus(status: RecordingControllerStatus): boolean {
  return (
    status === "requestingPermission" ||
    status === "recording" ||
    status === "paused" ||
    status === "stopping" ||
    status === "processing"
  );
}

function errorToInfo(err: unknown): { code: string; message: string } {
  if (err instanceof Error) return { code: err.name, message: err.message };
  return { code: "unknown", message: String(err) };
}

async function resolveMedia(
  mediaSource: RecordingControllerOptions["mediaSource"],
): Promise<PackageBuildInput["media"]> {
  if (!mediaSource) return null;
  try {
    return await mediaSource();
  } catch (err) {
    console.warn("[recording-controller] mediaSource threw:", err);
    return null;
  }
}

function persistenceError(code: string, reason: string, message: string): Error {
  const error = new Error(`${code}: ${reason}: ${message}`);
  error.name = code;
  return error;
}
