import { describe, expect, it, vi } from "vitest";
import { createMediaDevicesController } from "../mediaDevices";

type TrackKind = "audio" | "video";

function makeFakeTrack(kind: TrackKind): MediaStreamTrack {
  const listeners = new Map<string, EventListener[]>();
  return {
    kind,
    stop: vi.fn(),
    enabled: true,
    addEventListener(type: string, listener: EventListener) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
  } as unknown as MediaStreamTrack;
}

function makeFakeStream(tracks: MediaStreamTrack[]): MediaStream {
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
  } as unknown as MediaStream;
}

function setupNavigator(getUserMedia: typeof navigator.mediaDevices.getUserMedia) {
  return {
    enumerateDevices: vi.fn(async () => [
      { kind: "audioinput", deviceId: "mic-1", label: "Mic 1" },
      { kind: "videoinput", deviceId: "cam-1", label: "Cam 1" },
    ]),
    getUserMedia,
  } as unknown as MediaDevices;
}

describe("createMediaDevicesController", () => {
  it("enumerate returns separated audio and camera lists", async () => {
    const md = setupNavigator(vi.fn());
    const controller = createMediaDevicesController({ navigatorMediaDevices: md });
    const devices = await controller.enumerate();
    expect(devices.audio.length).toBe(1);
    expect(devices.camera.length).toBe(1);
    expect(devices.audio[0].deviceId).toBe("mic-1");
  });

  it("openStream maps NotAllowedError to permission-denied warning", async () => {
    const md = setupNavigator(vi.fn(async () => {
      const err = new Error("blocked by user");
      (err as Error & { name: string }).name = "NotAllowedError";
      throw err;
    }));
    const controller = createMediaDevicesController({ navigatorMediaDevices: md });
    const result = await controller.openStream({ audioDeviceId: "mic-1", cameraDeviceId: null });
    expect(result.stream).toBeNull();
    expect(result.warnings[0].code).toBe("permission-denied");
  });

  it("openStream maps NotFoundError to not-found warning", async () => {
    const md = setupNavigator(vi.fn(async () => {
      const err = new Error("no device");
      (err as Error & { name: string }).name = "NotFoundError";
      throw err;
    }));
    const controller = createMediaDevicesController({ navigatorMediaDevices: md });
    const result = await controller.openStream({ audioDeviceId: null, cameraDeviceId: "cam-1" });
    expect(result.warnings[0].code).toBe("not-found");
  });

  it("openStream maps unsupported errors to unsupported warning", async () => {
    const md = setupNavigator(vi.fn(async () => {
      const err = new Error("camera is unsupported");
      (err as Error & { name: string }).name = "NotSupportedError";
      throw err;
    }));
    const controller = createMediaDevicesController({ navigatorMediaDevices: md });
    const result = await controller.openStream({ audioDeviceId: null, cameraDeviceId: "cam-1" });
    expect(result.warnings[0].code).toBe("unsupported");
  });

  it("openStream keeps unknown errors as recorder-error warnings", async () => {
    const md = setupNavigator(vi.fn(async () => {
      const err = new Error("unexpected media stack failure");
      (err as Error & { name: string }).name = "TypeError";
      throw err;
    }));
    const controller = createMediaDevicesController({ navigatorMediaDevices: md });
    const result = await controller.openStream({ audioDeviceId: null, cameraDeviceId: "cam-1" });
    expect(result.warnings[0].code).toBe("recorder-error");
  });

  it("openStream succeeds and capability tracks selected devices", async () => {
    const stream = makeFakeStream([makeFakeTrack("audio"), makeFakeTrack("video")]);
    const md = setupNavigator(vi.fn(async () => stream));
    const controller = createMediaDevicesController({ navigatorMediaDevices: md });
    const result = await controller.openStream({ audioDeviceId: "mic-1", cameraDeviceId: "cam-1" });
    expect(result.stream).toBe(stream);
    expect(result.capability.selectedAudioDeviceId).toBe("mic-1");
    expect(result.capability.selectedCameraDeviceId).toBe("cam-1");
  });

  it("openStream uses default devices when device ids are undefined", async () => {
    const audioStream = makeFakeStream([makeFakeTrack("audio")]);
    const cameraStream = makeFakeStream([makeFakeTrack("video")]);
    const getUserMedia = vi.fn().mockResolvedValueOnce(audioStream).mockResolvedValueOnce(cameraStream);
    const md = setupNavigator(getUserMedia);
    const controller = createMediaDevicesController({ navigatorMediaDevices: md });

    const result = await controller.openStream({});

    expect(getUserMedia).toHaveBeenNthCalledWith(1, { audio: true, video: false });
    expect(getUserMedia).toHaveBeenNthCalledWith(2, { audio: false, video: true });
    expect(result.stream?.getAudioTracks()).toHaveLength(1);
    expect(result.stream?.getVideoTracks()).toHaveLength(1);
    expect(result.capability.selectedAudioDeviceId).toBeNull();
    expect(result.capability.selectedCameraDeviceId).toBeNull();
  });

  it("openStream treats null device ids as disabled tracks without marking devices unsupported", async () => {
    const audioStream = makeFakeStream([makeFakeTrack("audio")]);
    const getUserMedia = vi.fn(async () => audioStream);
    const md = setupNavigator(getUserMedia);
    const controller = createMediaDevicesController({ navigatorMediaDevices: md });

    const result = await controller.openStream({ audioDeviceId: "mic-1", cameraDeviceId: null });

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { deviceId: { exact: "mic-1" } },
      video: false,
    });
    expect(result.stream?.getAudioTracks()).toHaveLength(1);
    expect(result.stream?.getVideoTracks()).toHaveLength(0);
    expect(result.capability.audio).toBe("available");
    expect(result.capability.camera).toBe("available");
    expect(result.capability.selectedAudioDeviceId).toBe("mic-1");
    expect(result.capability.selectedCameraDeviceId).toBeNull();
  });

  it("openStream returns event-only capability without getUserMedia when both tracks are null", async () => {
    const getUserMedia = vi.fn();
    const md = setupNavigator(getUserMedia);
    const controller = createMediaDevicesController({ navigatorMediaDevices: md });

    const result = await controller.openStream({ audioDeviceId: null, cameraDeviceId: null });

    expect(getUserMedia).not.toHaveBeenCalled();
    expect(result.stream).toBeNull();
    expect(result.warnings).toEqual([]);
    expect(result.capability.audio).toBe("available");
    expect(result.capability.camera).toBe("available");
    expect(result.capability.selectedAudioDeviceId).toBeNull();
    expect(result.capability.selectedCameraDeviceId).toBeNull();
  });

  it("keeps the camera stream when the microphone request is denied", async () => {
    const cameraStream = makeFakeStream([makeFakeTrack("video")]);
    const denied = new Error("blocked by user");
    (denied as Error & { name: string }).name = "NotAllowedError";
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(denied)
      .mockResolvedValueOnce(cameraStream);
    const md = setupNavigator(getUserMedia);
    const controller = createMediaDevicesController({ navigatorMediaDevices: md });

    const result = await controller.openStream({ audioDeviceId: "mic-1", cameraDeviceId: "cam-1" });

    expect(result.stream?.getVideoTracks()).toHaveLength(1);
    expect(result.stream?.getAudioTracks()).toHaveLength(0);
    expect(result.capability.audio).toBe("denied");
    expect(result.capability.camera).toBe("available");
    expect(result.capability.selectedAudioDeviceId).toBe("mic-1");
    expect(result.capability.selectedCameraDeviceId).toBe("cam-1");
    expect(result.warnings).toEqual([
      expect.objectContaining({
        target: "audio",
        code: "permission-denied",
      }),
    ]);
  });

  it("release stops all active stream tracks", async () => {
    const stopAudio = vi.fn();
    const stopVideo = vi.fn();
    const tracks = [
      { kind: "audio" as const, stop: stopAudio, enabled: true, addEventListener: () => {} },
      { kind: "video" as const, stop: stopVideo, enabled: true, addEventListener: () => {} },
    ] as unknown as MediaStreamTrack[];
    const stream = makeFakeStream(tracks);
    const md = setupNavigator(vi.fn(async () => stream));
    const controller = createMediaDevicesController({ navigatorMediaDevices: md });
    await controller.openStream({ audioDeviceId: "mic-1", cameraDeviceId: "cam-1" });
    controller.release();
    expect(stopAudio).toHaveBeenCalled();
    expect(stopVideo).toHaveBeenCalled();
  });
});
