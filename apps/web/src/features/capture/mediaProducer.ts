import type { CreateMediaProducer, MediaProducerHandle } from "./types";
import type { MediaWarningPayload, MediaCapability } from "@/shared/recording-schema";

type MediaCapabilityTarget = "audio" | "camera";
type MediaCapabilityState = MediaCapability[MediaCapabilityTarget];

export const createMediaProducer: CreateMediaProducer = (deps): MediaProducerHandle => {
  const { clock } = deps;
  let isPaused = false;
  let isStopped = true;
  let unsubscribeDevices: (() => void) | null = null;

  let microphoneEnabled = true;
  let cameraEnabled = true;

  let lastAudioState: MediaCapability["audio"] = "available";
  let lastCameraState: MediaCapability["camera"] = "available";

  let lastPositionTime = -Infinity;
  let pendingPosition: { x: number; y: number } | null = null;
  let throttleTimer: ReturnType<typeof setTimeout> | null = null;

  const flushPosition = () => {
    if (!pendingPosition || isPaused || isStopped) return;
    deps.bus.emit({
      type: "camera-position",
      source: "media",
      track: "ui",
      payload: pendingPosition,
    });
    pendingPosition = null;
    lastPositionTime = clock.now();
  };

  const stopProducer = () => {
    isStopped = true;
    if (unsubscribeDevices) {
      unsubscribeDevices();
      unsubscribeDevices = null;
    }
    if (throttleTimer) {
      clearTimeout(throttleTimer);
      throttleTimer = null;
    }
    pendingPosition = null;
    lastPositionTime = -Infinity;
  };

  const handleCapability = (capability: MediaCapability) => {
    if (isStopped) return; // Note: DO NOT block on isPaused. Users need warnings even if paused.

    const codeForState = (state: MediaCapabilityState): MediaWarningPayload["code"] | null => {
      switch (state) {
        case "available":
          return null;
        case "denied":
          return "permission-denied";
        case "busy":
          return "busy";
        case "not-found":
          return "not-found";
        case "unsupported":
          return "unsupported";
      }
    };

    const checkTarget = <Target extends MediaCapabilityTarget>(
      target: Target,
      state: MediaCapability[Target],
      lastState: MediaCapability[Target],
      updateState: (newState: MediaCapability[Target]) => void,
    ) => {
      if (state === lastState) return;
      updateState(state);

      const code = codeForState(state);
      if (!code) return;

      deps.bus.emit({
        type: "media-warning",
        source: "media",
        track: "media",
        payload: {
          target,
          code,
          message: `Device capability downgraded to ${state}`,
        },
      });
    };

    checkTarget("audio", capability.audio, lastAudioState, (s) => (lastAudioState = s));
    checkTarget("camera", capability.camera, lastCameraState, (s) => (lastCameraState = s));
  };

  return {
    start() {
      if (!isStopped || unsubscribeDevices) return;
      isStopped = false;
      isPaused = false;
      lastAudioState = "available";
      lastCameraState = "available";
      lastPositionTime = -Infinity;
      unsubscribeDevices = deps.devices.subscribe(handleCapability);
      handleCapability(deps.getCapability());
    },
    pause() {
      isPaused = true;
      if (throttleTimer) {
        clearTimeout(throttleTimer);
        throttleTimer = null;
      }
      pendingPosition = null;
    },
    resume() {
      isPaused = false;
    },
    stop() {
      stopProducer();
    },
    dispose() {
      stopProducer();
      deps.devices.release();
    },
    setMicrophoneEnabled(enabled: boolean) {
      if (isPaused || isStopped) return;
      microphoneEnabled = enabled;
      deps.devices.setTrackEnabled("audio", enabled);
      deps.bus.emit({
        type: "media-toggle",
        source: "media",
        track: "media",
        payload: {
          microphoneEnabled,
          cameraEnabled,
        },
      });
    },
    setCameraEnabled(enabled: boolean) {
      if (isPaused || isStopped) return;
      cameraEnabled = enabled;
      deps.devices.setTrackEnabled("camera", enabled);
      deps.bus.emit({
        type: "media-toggle",
        source: "media",
        track: "media",
        payload: {
          microphoneEnabled,
          cameraEnabled,
        },
      });
    },
    reportCameraPosition(position: { x: number; y: number }) {
      if (isPaused || isStopped) return;
      if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) return;
      const x = Math.min(Math.max(position.x, 0), 1);
      const y = Math.min(Math.max(position.y, 0), 1);
      pendingPosition = { x, y };

      const now = clock.now();
      if (now - lastPositionTime >= 50) {
        if (throttleTimer) {
          clearTimeout(throttleTimer);
          throttleTimer = null;
        }
        flushPosition();
      } else if (!throttleTimer) {
        // RecordingClock has no scheduler; the timer only delays the trailing flush while clock.now() stays authoritative.
        throttleTimer = setTimeout(
          () => {
            throttleTimer = null;
            flushPosition();
          },
          50 - (now - lastPositionTime),
        );
      }
    },
  };
};
