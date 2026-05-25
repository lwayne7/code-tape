import type { CreateMediaProducer, MediaProducerHandle } from "./types";
import type { MediaWarningPayload, MediaCapability } from "@/shared/recording-schema";

export const createMediaProducer: CreateMediaProducer = (deps): MediaProducerHandle => {
  let isPaused = false;
  let isStopped = true;
  let unsubscribeDevices: (() => void) | null = null;
  
  let microphoneEnabled = true;
  let cameraEnabled = true;

  let lastPositionTime = 0;
  let pendingPosition: { x: number; y: number } | null = null;
  let throttleTimer: ReturnType<typeof setTimeout> | null = null;

  const flushPosition = () => {
    if (!pendingPosition || isPaused || isStopped) return;
    deps.bus.emit({
      type: "camera-position",
      source: "media",
      track: "ui",
      payload: pendingPosition
    });
    pendingPosition = null;
    lastPositionTime = performance.now();
  };

  const handleCapability = (capability: MediaCapability) => {
    if (isStopped) return; // Note: DO NOT block on isPaused. Users need warnings even if paused.
    const checkTarget = (target: "audio" | "camera", state: MediaCapability["audio"]) => {
      if (state === "denied" || state === "busy" || state === "not-found" || state === "unsupported") {
        let code: MediaWarningPayload["code"] = "not-found";
        if (state === "denied") code = "permission-denied";
        else if (state === "busy") code = "busy";
        else if (state === "unsupported") code = "not-found";
        
        deps.bus.emit({
          type: "media-warning",
          source: "media",
          track: "media",
          payload: {
            target,
            code,
            message: `Device capability downgraded to ${state}`
          }
        });
      }
    };
    checkTarget("audio", capability.audio);
    checkTarget("camera", capability.camera);
  };

  return {
    start() {
      isStopped = false;
      isPaused = false;
      unsubscribeDevices = deps.devices.subscribe(handleCapability);
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
    },
    dispose() {
      this.stop();
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
        }
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
        }
      });
    },
    reportCameraPosition(position: { x: number; y: number }) {
      if (isPaused || isStopped) return;
      const x = Math.min(Math.max(position.x, 0), 1);
      const y = Math.min(Math.max(position.y, 0), 1);
      pendingPosition = { x, y };
      
      const now = Math.round(performance.now());
      if (now - lastPositionTime >= 50) {
        if (throttleTimer) {
          clearTimeout(throttleTimer);
          throttleTimer = null;
        }
        flushPosition();
      } else if (!throttleTimer) {
        throttleTimer = setTimeout(() => {
          throttleTimer = null;
          flushPosition();
        }, 50 - (now - lastPositionTime));
      }
    },
  };
};
