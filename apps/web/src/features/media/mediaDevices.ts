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

  const warningCodeForOpenStreamError = (
    err: unknown,
    status: MediaCapability["audio"],
  ): MediaWarningPayload["code"] => {
    if (status === "denied") return "permission-denied";
    if (status === "not-found") return "not-found";
    if (status === "busy") return "busy";
    if (err instanceof Error && err.name === "NotSupportedError") return "unsupported";
    return "recorder-error";
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
        const nextCapability = { ...capability, audio: "unsupported" as const, camera: "unsupported" as const };
        updateCapability(nextCapability);
        return {
          stream: null,
          capability: nextCapability,
          warnings: [{ target: "recorder", code: "unsupported", message: "getUserMedia not available" }],
        };
      }
      stopActiveStream();

      const nextCapability: MediaCapability = {
        ...capability,
        audio: request.audioDeviceId === null ? "unsupported" : capability.audio,
        camera: request.cameraDeviceId === null ? "unsupported" : capability.camera,
        selectedAudioDeviceId: request.audioDeviceId,
        selectedCameraDeviceId: request.cameraDeviceId,
      };
      const streams: MediaStream[] = [];

      const openTrack = async (
        target: "audio" | "camera",
        deviceId: string | null,
      ): Promise<void> => {
        if (deviceId === null) return;
        try {
          const stream = await md.getUserMedia(
            target === "audio"
              ? { audio: { deviceId: { exact: deviceId } }, video: false }
              : { audio: false, video: { deviceId: { exact: deviceId } } },
          );
          streams.push(stream);
          nextCapability[target] = "available";
        } catch (err) {
          const status = classifyError(err);
          nextCapability[target] = status;
          warnings.push({
            target,
            code: warningCodeForOpenStreamError(err, status),
            message: err instanceof Error ? err.message : "Failed to open media stream",
          });
        }
      };

      await openTrack("audio", request.audioDeviceId);
      await openTrack("camera", request.cameraDeviceId);

      const stream = combineStreams(streams);
      if (stream) {
        activeStream = stream;
        for (const track of uniqueTracks(stream.getTracks())) {
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
      }
      updateCapability(nextCapability);
      return { stream, capability, warnings };
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

function uniqueTracks(tracks: MediaStreamTrack[]): MediaStreamTrack[] {
  return Array.from(new Set(tracks));
}

function combineStreams(streams: MediaStream[]): MediaStream | null {
  if (streams.length === 0) return null;
  const uniqueStreams = Array.from(new Set(streams));
  if (uniqueStreams.length === 1) return uniqueStreams[0];

  const tracks = uniqueTracks(streams.flatMap((stream) => stream.getTracks()));
  if (tracks.length === 0) return null;
  if (typeof MediaStream === "function") return new MediaStream(tracks);
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((track) => track.kind === "audio"),
    getVideoTracks: () => tracks.filter((track) => track.kind === "video"),
  } as unknown as MediaStream;
}
