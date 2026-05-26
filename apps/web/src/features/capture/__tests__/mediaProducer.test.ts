import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMediaProducer } from "../mediaProducer";
import type { MediaProducerDeps } from "../types";
import type { MediaDevicesController, EventBus, MediaCapability } from "@/shared/recording-schema";
import { createRecordingClock } from "@/features/recorder";

describe("createMediaProducer", () => {
  let mockBus: { emit: ReturnType<typeof vi.fn> };
  let mockDevices: {
    subscribe: ReturnType<typeof vi.fn>;
    setTrackEnabled: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };
  let deps: MediaProducerDeps;
  let listeners: ((cap: MediaCapability) => void)[] = [];
  let wall: number;
  let clock: ReturnType<typeof createRecordingClock>;

  const defaultCapability = (): MediaCapability => ({
    audio: "available",
    camera: "available",
    selectedAudioDeviceId: null,
    selectedCameraDeviceId: null,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    listeners = [];
    wall = 1000;

    mockBus = {
      emit: vi.fn(),
    };

    mockDevices = {
      subscribe: vi.fn((listener) => {
        listeners.push(listener);
        return () => {
          listeners = listeners.filter((l) => l !== listener);
        };
      }),
      setTrackEnabled: vi.fn(),
      release: vi.fn(),
    };

    clock = createRecordingClock({ nowProvider: () => wall });
    clock.start();

    deps = {
      bus: mockBus as unknown as EventBus,
      devices: mockDevices as unknown as MediaDevicesController,
      clock,
      getCapability: vi.fn(defaultCapability),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const triggerCapability = (cap: Partial<MediaCapability>) => {
    const fullCap: MediaCapability = {
      audio: "available",
      camera: "available",
      selectedAudioDeviceId: null,
      selectedCameraDeviceId: null,
      ...cap,
    };
    listeners.forEach((l) => l(fullCap));
  };

  it("should emit media-warning on start when getCapability already reports errors", () => {
    deps.getCapability = vi.fn(
      (): MediaCapability => ({
        ...defaultCapability(),
        audio: "denied",
        camera: "busy",
      }),
    );

    const producer = createMediaProducer(deps);
    producer.start();

    expect(deps.getCapability).toHaveBeenCalled();
    expect(mockBus.emit).toHaveBeenCalledTimes(2);
    expect(mockBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "media-warning",
        payload: { target: "audio", code: "permission-denied", message: expect.any(String) },
      }),
    );
    expect(mockBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "media-warning",
        payload: { target: "camera", code: "busy", message: expect.any(String) },
      }),
    );
  });

  it("should emit media-warning when capability downgrades", () => {
    const producer = createMediaProducer(deps);
    producer.start();

    // Trigger audio denied
    triggerCapability({ audio: "denied" });
    expect(mockBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "media-warning",
        payload: { target: "audio", code: "permission-denied", message: expect.any(String) },
      }),
    );

    // Trigger camera not-found
    mockBus.emit.mockClear();
    triggerCapability({ camera: "not-found" });
    expect(mockBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "media-warning",
        payload: { target: "camera", code: "not-found", message: expect.any(String) },
      }),
    );

    mockBus.emit.mockClear();
    triggerCapability({ camera: "unsupported" });
    expect(mockBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "media-warning",
        payload: {
          target: "camera",
          code: "unsupported",
          message: expect.stringContaining("unsupported"),
        },
      }),
    );
  });

  it("should ignore events when paused, but still emit warnings. ignore all when stopped", () => {
    const producer = createMediaProducer(deps);
    producer.start();
    producer.pause();

    // Warnings SHOULD be emitted during pause
    triggerCapability({ audio: "denied" });
    expect(mockBus.emit).toHaveBeenCalledWith(expect.objectContaining({ type: "media-warning" }));
    mockBus.emit.mockClear();

    // Inputs SHOULD be ignored during pause
    producer.setMicrophoneEnabled(false);
    producer.reportCameraPosition({ x: 0.5, y: 0.5 });

    expect(mockBus.emit).not.toHaveBeenCalled();

    producer.resume();
    producer.setMicrophoneEnabled(false);
    expect(mockBus.emit).toHaveBeenCalledTimes(1); // the media-toggle
    mockBus.emit.mockClear();

    producer.stop();
    // Warning SHOULD be ignored when stopped
    triggerCapability({ audio: "denied" });
    producer.setMicrophoneEnabled(true);
    expect(mockBus.emit).not.toHaveBeenCalled();
  });

  it("should call setTrackEnabled and emit media-toggle payload on setMicrophoneEnabled / setCameraEnabled", () => {
    const producer = createMediaProducer(deps);
    producer.start();

    producer.setMicrophoneEnabled(true);
    expect(mockDevices.setTrackEnabled).toHaveBeenCalledWith("audio", true);
    expect(mockBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "media-toggle",
        payload: { microphoneEnabled: true, cameraEnabled: true }, // camera default is true
      }),
    );

    producer.setCameraEnabled(false);
    expect(mockDevices.setTrackEnabled).toHaveBeenCalledWith("camera", false);
    expect(mockBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "media-toggle",
        payload: { microphoneEnabled: true, cameraEnabled: false },
      }),
    );
  });

  it("should emit camera-position with 50ms throttle using injected clock and clamp coordinates", () => {
    const producer = createMediaProducer(deps);
    producer.start();

    // Out of bounds position flushes immediately at clock.now() === 0
    producer.reportCameraPosition({ x: -1, y: 2 });

    expect(mockBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "camera-position",
        payload: { x: 0, y: 1 },
      }),
    );
    mockBus.emit.mockClear();

    // Advance injected clock within throttle window
    wall += 10;
    producer.reportCameraPosition({ x: 0.5, y: 0.5 });
    producer.reportCameraPosition({ x: 0.6, y: 0.6 });
    producer.reportCameraPosition({ x: 0.7, y: 0.7 });

    expect(mockBus.emit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(40);
    expect(mockBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "camera-position",
        payload: { x: 0.7, y: 0.7 },
      }),
    );
  });

  it("should emit the first camera-position immediately after stop and restart", () => {
    const producer = createMediaProducer(deps);
    producer.start();

    producer.reportCameraPosition({ x: 0.1, y: 0.1 });
    expect(mockBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "camera-position",
        payload: { x: 0.1, y: 0.1 },
      }),
    );

    mockBus.emit.mockClear();
    producer.stop();
    producer.start();
    producer.reportCameraPosition({ x: 0.2, y: 0.2 });

    expect(mockBus.emit).toHaveBeenCalledTimes(1);
    expect(mockBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "camera-position",
        payload: { x: 0.2, y: 0.2 },
      }),
    );
  });

  it("should clear subscriptions and release devices on dispose", () => {
    const producer = createMediaProducer(deps);
    producer.start();

    expect(listeners.length).toBe(1);

    producer.dispose();

    expect(listeners.length).toBe(0);
    expect(mockDevices.release).toHaveBeenCalled();
  });

  it("should be idempotent on start and not leak subscriptions on multiple starts", () => {
    const producer = createMediaProducer(deps);
    producer.start();
    producer.start();
    producer.start();

    expect(mockDevices.subscribe).toHaveBeenCalledTimes(1);
    expect(listeners.length).toBe(1);

    producer.stop();
    expect(listeners.length).toBe(0);

    producer.start();
    expect(mockDevices.subscribe).toHaveBeenCalledTimes(2);
    expect(listeners.length).toBe(1);

    producer.stop();
    expect(listeners.length).toBe(0);
  });

  it("should re-emit media-warning after stop and restart when capability is still failing", () => {
    deps.getCapability = vi.fn(
      (): MediaCapability => ({
        ...defaultCapability(),
        audio: "denied",
      }),
    );

    const producer = createMediaProducer(deps);
    producer.start();
    expect(mockBus.emit).toHaveBeenCalledTimes(1);

    producer.stop();
    mockBus.emit.mockClear();

    producer.start();
    expect(mockBus.emit).toHaveBeenCalledTimes(1);
    expect(mockBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "media-warning",
        payload: { target: "audio", code: "permission-denied", message: expect.any(String) },
      }),
    );
  });

  it("should not emit duplicate media-warnings for continuous identical capability errors", () => {
    const producer = createMediaProducer(deps);
    producer.start();

    // Trigger audio denied
    triggerCapability({ audio: "denied" });
    expect(mockBus.emit).toHaveBeenCalledTimes(1);

    // Trigger audio denied again (should not emit)
    triggerCapability({ audio: "denied" });
    expect(mockBus.emit).toHaveBeenCalledTimes(1);

    // Trigger audio busy (changed error state, should emit)
    triggerCapability({ audio: "busy" });
    expect(mockBus.emit).toHaveBeenCalledTimes(2);
  });

  it("should emit again if capability recovers and then fails again", () => {
    const producer = createMediaProducer(deps);
    producer.start();

    triggerCapability({ camera: "busy" });
    expect(mockBus.emit).toHaveBeenCalledTimes(1);

    // Recovery
    triggerCapability({ camera: "available" });
    expect(mockBus.emit).toHaveBeenCalledTimes(1); // No emit for available

    // Fails again
    triggerCapability({ camera: "busy" });
    expect(mockBus.emit).toHaveBeenCalledTimes(2);
  });

  it("should support calling dispose as a naked function (React cleanup style) without throwing", () => {
    const producer = createMediaProducer(deps);
    producer.start();

    const { dispose } = producer;

    expect(() => dispose()).not.toThrow();
    expect(listeners.length).toBe(0);
    expect(mockDevices.release).toHaveBeenCalled();
  });

  it("should cancel pending throttled camera-position emissions when stopped or disposed", () => {
    const producer = createMediaProducer(deps);
    producer.start();

    // Trigger a position change when at the start of throttled window
    producer.reportCameraPosition({ x: 0.1, y: 0.1 });
    producer.reportCameraPosition({ x: 0.2, y: 0.2 }); // This one will be queued by the timer

    producer.stop(); // Wait, let's test dispose or stop cancels the timer

    vi.advanceTimersByTime(50);

    expect(mockBus.emit).toHaveBeenCalledTimes(1); // Only the first one which flushed immediately
    expect(mockBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { x: 0.1, y: 0.1 } }),
    );

    mockBus.emit.mockClear();
    wall += 500;

    // Restart and test dispose
    producer.start();
    producer.reportCameraPosition({ x: 0.3, y: 0.3 }); // flushes immediately because injected clock advanced
    producer.reportCameraPosition({ x: 0.4, y: 0.4 }); // queued

    const { dispose } = producer;
    dispose();

    vi.advanceTimersByTime(50);

    expect(mockBus.emit).toHaveBeenCalledTimes(1); // Only the 0.3, 0.3
    expect(mockBus.emit).not.toHaveBeenCalledWith(
      expect.objectContaining({ payload: { x: 0.4, y: 0.4 } }),
    );
  });
});
