import type {
  MediaRecorderChunk,
  MediaRecorderResult,
  MediaRecorderWrapper,
  MediaWarningPayload,
} from "@/shared/recording-schema";

export type MediaRecorderWrapperOptions = {
  /** Pick a supported mime type. Defaults to webm-opus-vp9 then -vp8 fallback. */
  preferredMimeTypes?: string[];
  /** Timeslice for dataavailable callbacks (ms). Defaults to 1000. */
  timesliceMs?: number;
};

const DEFAULT_MIMES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "audio/webm;codecs=opus",
  "audio/webm",
];

function pickMimeType(preferred: string[]): string {
  if (typeof MediaRecorder === "undefined") return preferred[0] ?? "video/webm";
  for (const mime of preferred) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return preferred[0] ?? "video/webm";
}

/**
 * MediaRecorderWrapper — owns the underlying MediaRecorder + collected chunks.
 *
 * Lifecycle parity with the controller: start / pause / resume / stop. On stop
 * the wrapper concatenates chunks into a single Blob keyed by the chosen mime
 * type. Callers also get streaming `onChunk` for future incremental upload —
 * not used in P0 but the contract reserves the seam.
 */
export function createMediaRecorderWrapper(
  options: MediaRecorderWrapperOptions = {},
): MediaRecorderWrapper {
  const preferred = options.preferredMimeTypes ?? DEFAULT_MIMES;
  const timesliceMs = options.timesliceMs ?? 1000;

  let recorder: MediaRecorder | null = null;
  let chunks: BlobPart[] = [];
  let startedAt = 0;
  let mimeType = "";
  let hasAudio = false;
  let hasCamera = false;

  const chunkListeners = new Set<(chunk: MediaRecorderChunk) => void>();
  const errorListeners = new Set<(error: MediaWarningPayload) => void>();

  return {
    async start(stream: MediaStream) {
      if (typeof MediaRecorder === "undefined") {
        const warning: MediaWarningPayload = {
          target: "recorder",
          code: "recorder-error",
          message: "MediaRecorder not supported in this environment",
        };
        errorListeners.forEach((listener) => listener(warning));
        throw new Error(warning.message);
      }
      mimeType = pickMimeType(preferred);
      hasAudio = stream.getAudioTracks().length > 0;
      hasCamera = stream.getVideoTracks().length > 0;
      chunks = [];
      recorder = new MediaRecorder(stream, { mimeType });
      recorder.addEventListener("dataavailable", (event: BlobEvent) => {
        if (event.data && event.data.size > 0) {
          chunks.push(event.data);
          chunkListeners.forEach((listener) =>
            listener({ data: event.data, timestampMs: performance.now() - startedAt }),
          );
        }
      });
      recorder.addEventListener("error", (event: Event) => {
        const error = (event as Event & { error?: Error }).error;
        errorListeners.forEach((listener) =>
          listener({
            target: "recorder",
            code: "recorder-error",
            message: error?.message ?? "MediaRecorder error",
          }),
        );
      });
      startedAt = performance.now();
      recorder.start(timesliceMs);
    },
    pause() {
      if (recorder && recorder.state === "recording") recorder.pause();
    },
    resume() {
      if (recorder && recorder.state === "paused") recorder.resume();
    },
    async stop(): Promise<MediaRecorderResult> {
      if (!recorder) {
        return {
          blob: new Blob([], { type: mimeType }),
          mimeType: mimeType || "video/webm",
          durationMs: 0,
          hasAudio,
          hasCamera,
        };
      }
      return new Promise((resolve) => {
        recorder!.addEventListener(
          "stop",
          () => {
            const blob = new Blob(chunks, { type: mimeType });
            const durationMs = performance.now() - startedAt;
            recorder = null;
            chunks = [];
            resolve({ blob, mimeType, durationMs, hasAudio, hasCamera });
          },
          { once: true },
        );
        recorder!.stop();
      });
    },
    onChunk(listener) {
      chunkListeners.add(listener);
      return () => chunkListeners.delete(listener);
    },
    onError(listener) {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
  };
}
