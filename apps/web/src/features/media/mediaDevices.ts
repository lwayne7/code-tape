import type {
  DeviceInfo,
  MediaCapability,
  MediaDevicesController,
  MediaWarningPayload,
  OpenStreamRequest,
  OpenStreamResult,
} from "@/shared/recording-schema";

export type MediaDevicesControllerOptions = {
  /** Inject `navigator.mediaDevices` (or a mock) for testability. */
  navigatorMediaDevices?: MediaDevices;
};

const INITIAL_CAPABILITY: MediaCapability = {
  audio: "unsupported",
  camera: "unsupported",
  selectedAudioDeviceId: null,
  selectedCameraDeviceId: null,
};

/**
 * MediaDevicesController — wraps `navigator.mediaDevices` so the rest of the
 * recorder talks in our schema's MediaCapability vocabulary.
 *
 * The controller deliberately does NOT cache streams — `openStream` always
 * tears down the previous one so callers don't end up holding stale tracks
 * across permission re-prompts.
 */
export function createMediaDevicesController(
  options: MediaDevicesControllerOptions = {},
): MediaDevicesController {
  const md = options.navigatorMediaDevices
    ?? (typeof navigator !== "undefined" ? navigator.mediaDevices : undefined);

  const capabilityListeners = new Set<(capability: MediaCapability) => void>();
  let capability: MediaCapability = {
    ...INITIAL_CAPABILITY,
    audio: md ? "available" : "unsupported",
    camera: md ? "available" : "unsupported",
  };
  let activeStream: MediaStream | null = null;

  const updateCapability = (patch: Partial<MediaCapability>) => {
    capability = { ...capability, ...patch };
    capabilityListeners.forEach((listener) => listener(capability));
  };

  const stopActiveStream = () => {
    if (!activeStream) return;
    activeStream.getTracks().forEach((track) => track.stop());
    activeStream = null;
  };

  const classifyError = (err: unknown): MediaCapability["audio"] => {
    if (!(err instanceof Error)) return "unsupported";
    if (err.name === "NotAllowedError" || err.name === "SecurityError") return "denied";
    if (err.name === "NotFoundError" || err.name === "OverconstrainedError") return "not-found";
    if (err.name === "NotReadableError" || err.name === "AbortError") return "busy";
    return "unsupported";
  };

  return {
    async enumerate() {
      if (!md) return { audio: [], camera: [] };
      const devices = await md.enumerateDevices();
      const audio: DeviceInfo[] = [];
      const camera: DeviceInfo[] = [];
      for (const d of devices) {
        if (d.kind === "audioinput") audio.push({ deviceId: d.deviceId, label: d.label, kind: "audioinput" });
        else if (d.kind === "videoinput") camera.push({ deviceId: d.deviceId, label: d.label, kind: "videoinput" });
      }
      return { audio, camera };
    },
    async requestPermission(kind) {
      if (!md) return "not-found";
      try {
        const constraints = kind === "audio" ? { audio: true } : { video: true };
        const stream = await md.getUserMedia(constraints);
        stream.getTracks().forEach((track) => track.stop());
        const status = "granted";
        updateCapability({ [kind === "audio" ? "audio" : "camera"]: "available" } as Partial<MediaCapability>);
        return status;
      } catch (err) {
        const status = classifyError(err);
        updateCapability({ [kind === "audio" ? "audio" : "camera"]: status } as Partial<MediaCapability>);
        return status === "denied" ? "denied" : status === "not-found" ? "not-found" : "busy";
      }
    },
    async openStream(request: OpenStreamRequest): Promise<OpenStreamResult> {
      const warnings: MediaWarningPayload[] = [];
      if (!md) {
        return {
          stream: null,
          capability: { ...capability, audio: "unsupported", camera: "unsupported" },
          warnings: [{ target: "recorder", code: "recorder-error", message: "getUserMedia not available" }],
        };
      }
      stopActiveStream();
      const constraints: MediaStreamConstraints = {
        audio: request.audioDeviceId
          ? { deviceId: { exact: request.audioDeviceId } }
          : !!request.audioDeviceId === false ? false : true,
        video: request.cameraDeviceId
          ? { deviceId: { exact: request.cameraDeviceId } }
          : !!request.cameraDeviceId === false ? false : true,
      };
      if (request.audioDeviceId === null) constraints.audio = false;
      if (request.cameraDeviceId === null) constraints.video = false;
      try {
        const stream = await md.getUserMedia(constraints);
        activeStream = stream;
        for (const track of stream.getTracks()) {
          track.addEventListener("ended", () => {
            warnings.push({
              target: track.kind === "audio" ? "audio" : "camera",
              code: "track-ended",
              message: `${track.kind} track ended`,
            });
            updateCapability({
              [track.kind === "audio" ? "audio" : "camera"]: "not-found",
            } as Partial<MediaCapability>);
          });
        }
        updateCapability({
          audio: stream.getAudioTracks().length > 0 ? "available" : capability.audio,
          camera: stream.getVideoTracks().length > 0 ? "available" : capability.camera,
          selectedAudioDeviceId: request.audioDeviceId,
          selectedCameraDeviceId: request.cameraDeviceId,
        });
        return { stream, capability, warnings };
      } catch (err) {
        const code = classifyError(err);
        const target: MediaWarningPayload["target"] =
          request.cameraDeviceId !== null ? "camera" : "audio";
        warnings.push({
          target,
          code: code === "denied"
            ? "permission-denied"
            : code === "not-found"
              ? "not-found"
            : code === "busy"
              ? "busy"
              : "unsupported",
          message: (err as Error).message,
        });
        return { stream: null, capability, warnings };
      }
    },
    setTrackEnabled(kind, enabled) {
      if (!activeStream) return;
      for (const track of activeStream.getTracks()) {
        if (
          (kind === "audio" && track.kind === "audio") ||
          (kind === "camera" && track.kind === "video")
        ) {
          track.enabled = enabled;
        }
      }
    },
    release() {
      stopActiveStream();
      updateCapability(INITIAL_CAPABILITY);
    },
    subscribe(listener) {
      capabilityListeners.add(listener);
      listener(capability);
      return () => capabilityListeners.delete(listener);
    },
  };
}
