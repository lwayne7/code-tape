import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createRecordingClock } from "./recordingClock";
import { createEventBus } from "./eventBus";
import { createPackageBuilder } from "./packageBuilder";
import { createRecordingController } from "./recordingController";
import { RecorderControls } from "./RecorderControls";
import { CodeEditor, type CodeEditorHandle } from "@/features/editor/CodeEditor";
import { CameraPreview } from "@/features/media/CameraPreview";
import { PreviewPane } from "@/features/runtime-preview/PreviewPane";
import { createPreviewCompiler } from "@/features/runtime-preview/previewCompiler";
import { createIframeRuntime } from "@/features/runtime-preview/iframeRuntime";
import { createMediaDevicesController } from "@/features/media/mediaDevices";
import { createMediaRecorderWrapper } from "@/features/media/mediaRecorder";
import { createRecordingStore } from "@/features/library/recordingStore";
import {
  createEditorProducer,
  createMediaProducer,
  createPointerProducer,
  createRuntimeProducer,
  createShortcutProducer,
} from "@/features/capture";
import type {
  CameraPositionPayload,
  MediaCapability,
  MediaDevicesController,
  OpenStreamResult,
  RecordingControllerState,
  RecordingControllerStatus,
  RecordingLanguage,
  PackageBuildInput,
  RecordStartPayload,
  RunStartPayload,
} from "@/shared/recording-schema";

const INITIAL_CONTROLLER_STATE: RecordingControllerState = {
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

const INITIAL_CAMERA_POSITION: CameraPositionPayload = { x: 0.85, y: 0.85 };

const APP_VERSION = "0.0.0";

/**
 * RecorderPage — wires the recording core (clock + bus + producers + builder
 * + repository + media + runtime) and renders the workshop layout.
 */
export function RecorderPage() {
  const navigate = useNavigate();
  const editorRef = useRef<CodeEditorHandle | null>(null);
  const mediaRecorderRef = useRef<ReturnType<typeof createMediaRecorderWrapper> | null>(null);
  const mountedRef = useRef(true);
  const startInFlightRef = useRef(false);
  const startTokenRef = useRef(0);
  const stopTokenRef = useRef(0);
  const [mediaStream, setMediaStream] = useState<MediaStream | null>(null);

  const stack = useMemo(() => {
    const clock = createRecordingClock();
    const bus = createEventBus({ clock });
    const compiler = createPreviewCompiler();
    const runtime = createIframeRuntime();
    const repository = createRecordingStore();
    const devices = createMediaDevicesController();
    let currentEditorLanguage: RecordingLanguage = "javascript";
    let currentMediaCapability: MediaCapability = INITIAL_CONTROLLER_STATE.mediaCapability;
    const getCurrentRuntimeLanguage = (): RunStartPayload["language"] =>
      currentEditorLanguage === "typescript" ? "typescript" : "javascript";
    const editorProducer = createEditorProducer({
      bus,
      clock,
      getEditor: () => editorRef.current?.getEditor() ?? null,
      getCurrentLanguage: () => currentEditorLanguage,
      setModelLanguage: (_model, language) => {
        currentEditorLanguage = language;
        editorRef.current?.setModelLanguage(language);
      },
    });
    const pointerProducer = createPointerProducer({
      bus,
      clock,
      getHost: () => document.querySelector<HTMLElement>("[data-recorder-host]"),
    });
    const shortcutProducer = createShortcutProducer({
      bus,
      clock,
      getRoot: () => window,
    });
    const mediaProducer = createMediaProducer({
      bus,
      clock,
      devices,
      getCapability: () => currentMediaCapability,
    });
    const runtimeProducer = createRuntimeProducer({ bus, clock, compiler, runtime });
    const packageBuilder = createPackageBuilder();
    const controller = createRecordingController({
      clock,
      bus,
      producers: [editorProducer, pointerProducer, shortcutProducer, mediaProducer, runtimeProducer],
      packageBuilder,
      repository,
      appVersion: APP_VERSION,
      snapshotSource: () => editorProducer.takeSnapshot(),
      mediaSource: async () => {
        const recorder = mediaRecorderRef.current;
        mediaRecorderRef.current = null;
        try {
          if (!recorder) return null;
          const result = await recorder.stop();
          return {
            blob: result.blob,
            durationMs: result.durationMs,
            mimeType: result.mimeType,
            hasAudio: result.hasAudio,
            hasCamera: result.hasCamera,
          } satisfies PackageBuildInput["media"];
        } catch (err) {
          console.warn("[recorder-page] media finalization failed:", err);
          return null;
        } finally {
          devices.release();
          if (mountedRef.current) setMediaStream(null);
        }
      },
    });
    return {
      controller,
      bus,
      runtime,
      compiler,
      devices,
      editorProducer,
      mediaProducer,
      runtimeProducer,
      setCurrentMediaCapability: (capability: MediaCapability) => {
        currentMediaCapability = capability;
      },
      getCurrentEditorLanguage: () => currentEditorLanguage,
      getCurrentRuntimeLanguage,
    };
  }, []);

  const [controllerState, setControllerState] = useState<RecordingControllerState>(
    INITIAL_CONTROLLER_STATE,
  );
  const [microphoneEnabled, setMicrophoneEnabled] = useState(false);
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [cameraPosition, setCameraPosition] = useState<CameraPositionPayload>(
    INITIAL_CAMERA_POSITION,
  );

  useEffect(
    () => {
      mountedRef.current = true;
      return stack.controller.subscribe((nextState) => {
        if (mountedRef.current) setControllerState(nextState);
      });
    },
    [stack.controller],
  );
  useEffect(
    () => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
        startInFlightRef.current = false;
        startTokenRef.current += 1;
        stopTokenRef.current += 1;
        const isFinalizing = isFinalizingRecordingStatus(stack.controller.state.status);
        if (!isFinalizing) {
          stack.controller.reset();
          const recorder = mediaRecorderRef.current;
          mediaRecorderRef.current = null;
          void recorder?.stop().catch((err) => {
            console.warn("[recorder-page] cleanup media stop failed:", err);
          });
          stack.devices.release();
        }
      };
    },
    [stack.controller, stack.devices],
  );

  const isCurrentStart = (token: number) => mountedRef.current && startTokenRef.current === token;

  const handleStart = async () => {
    if (startInFlightRef.current) return;
    startInFlightRef.current = true;
    const startToken = (startTokenRef.current += 1);
    try {
      let media = await openDefaultMedia(stack.devices);
      if (!isCurrentStart(startToken)) {
        stack.devices.release();
        return;
      }
      if (media.stream) {
        setMediaStream(media.stream);
        let recorder: ReturnType<typeof createMediaRecorderWrapper> | null = null;
        try {
          recorder = createMediaRecorderWrapper();
          mediaRecorderRef.current = recorder;
          await recorder.start(media.stream);
          if (!isCurrentStart(startToken)) {
            if (mediaRecorderRef.current === recorder) {
              mediaRecorderRef.current = null;
              await recorder.stop().catch(() => undefined);
            }
            stack.devices.release();
            return;
          }
        } catch (err) {
          console.warn("[recorder-page] media recorder start failed:", err);
          if (recorder && mediaRecorderRef.current === recorder) {
            mediaRecorderRef.current = null;
            await recorder.stop().catch((stopErr) => {
              console.warn("[recorder-page] media recorder cleanup after start failed:", stopErr);
            });
          }
          if (!isCurrentStart(startToken)) {
            stack.devices.release();
            return;
          }
          stack.devices.release();
          setMediaStream(null);
          media = eventOnlyMedia();
        }
      }
      setMicrophoneEnabled(media.capability.audio === "available");
      setCameraEnabled(media.capability.camera === "available");
      stack.setCurrentMediaCapability(media.capability);

      const payload: RecordStartPayload = {
        initialLanguage: stack.getCurrentEditorLanguage(),
        initialFontSize: 14,
        initialTheme: "dark",
        selectedAudioDeviceId: media.capability.selectedAudioDeviceId,
        selectedCameraDeviceId: media.capability.selectedCameraDeviceId,
        mediaCapability: media.capability,
      };
      try {
        await stack.controller.start(payload);
        if (!isCurrentStart(startToken) && isActiveRecordingStatus(stack.controller.state.status)) {
          stack.controller.reset();
        }
      } catch (error) {
        const recorder = mediaRecorderRef.current;
        mediaRecorderRef.current = null;
        await recorder?.stop().catch(() => undefined);
        stack.devices.release();
        if (isCurrentStart(startToken)) {
          setMediaStream(null);
          setMicrophoneEnabled(false);
          setCameraEnabled(false);
          stack.setCurrentMediaCapability(INITIAL_CONTROLLER_STATE.mediaCapability);
        }
        throw error;
      }
    } finally {
      startInFlightRef.current = false;
    }
  };
  const handleStop = async () => {
    const stopToken = (stopTokenRef.current += 1);
    try {
      const pkg = await stack.controller.stop("user");
      if (mountedRef.current && stopTokenRef.current === stopToken) {
        navigate(`/replay/${pkg.meta.id}`);
      } else {
        stack.controller.reset();
      }
    } catch (error) {
      if (mountedRef.current && stopTokenRef.current === stopToken) throw error;
      stack.controller.reset();
      console.warn("[recorder-page] stop ignored after unmount:", error);
    }
  };
  const handlePause = () => {
    if (stack.controller.state.status !== "recording") return;
    const recorder = mediaRecorderRef.current;
    stack.controller.pause();
    try {
      recorder?.pause();
    } catch (err) {
      console.warn("[recorder-page] media pause failed:", err);
      void stack.controller.resume().catch((rollbackErr) => {
        console.warn("[recorder-page] controller pause rollback failed:", rollbackErr);
      });
    }
  };
  const handleResume = () => {
    if (stack.controller.state.status !== "paused") return;
    const recorder = mediaRecorderRef.current;
    try {
      recorder?.resume();
    } catch (err) {
      console.warn("[recorder-page] media resume failed:", err);
      return;
    }
    void stack.controller.resume().catch((err) => {
      console.warn("[recorder-page] controller resume failed:", err);
      try {
        recorder?.pause();
      } catch (rollbackErr) {
        console.warn("[recorder-page] media resume rollback failed:", rollbackErr);
      }
    });
  };
  const handleRun = async () => {
    const editor = editorRef.current?.getEditor();
    if (!editor) return;
    stack.editorProducer.flushPending();
    await stack.runtimeProducer.trigger({
      language: stack.getCurrentRuntimeLanguage(),
      source: editor.getValue(),
    });
  };

  return (
    <div className="flex h-full flex-col" data-recorder-host>
      <RecorderControls
        state={controllerState}
        microphoneEnabled={microphoneEnabled}
        cameraEnabled={cameraEnabled}
        onStart={handleStart}
        onPause={handlePause}
        onResume={handleResume}
        onStop={handleStop}
        onToggleMicrophone={(next) => {
          setMicrophoneEnabled(next);
          if (stack.controller.state.status === "paused") {
            stack.devices.setTrackEnabled("audio", next);
          }
          stack.mediaProducer.setMicrophoneEnabled(next);
        }}
        onToggleCamera={(next) => {
          setCameraEnabled(next);
          if (stack.controller.state.status === "paused") {
            stack.devices.setTrackEnabled("camera", next);
          }
          stack.mediaProducer.setCameraEnabled(next);
        }}
        onRun={handleRun}
      />
      <div className="grid flex-1 grid-cols-1 md:grid-cols-[1fr_minmax(320px,420px)]">
        <div className="relative border-r border-border">
          <CodeEditor
            ref={editorRef}
            language="javascript"
            initialValue=""
            fontSize={14}
            theme="dark"
          />
          <CameraPreview
            stream={mediaStream}
            enabled={cameraEnabled}
            position={cameraPosition}
            draggable
            onPositionChange={(next) => {
              setCameraPosition(next);
              stack.mediaProducer.reportCameraPosition(next);
            }}
          />
        </div>
        <PreviewPane runtime={stack.runtime} />
      </div>
    </div>
  );
}

async function openDefaultMedia(devices: MediaDevicesController): Promise<OpenStreamResult> {
  try {
    const available = await devices.enumerate();
    const audioDeviceId = available.audio[0]?.deviceId ?? null;
    const cameraDeviceId = available.camera[0]?.deviceId ?? null;

    if (!audioDeviceId && !cameraDeviceId) return eventOnlyMedia();

    const result = await devices.openStream({ audioDeviceId, cameraDeviceId });
    if (!result.stream) {
      devices.release();
      return eventOnlyMedia(result.warnings);
    }
    return result;
  } catch (err) {
    console.warn("[recorder-page] media devices unavailable:", err);
    devices.release();
    return eventOnlyMedia();
  }
}

function eventOnlyMedia(warnings: OpenStreamResult["warnings"] = []): OpenStreamResult {
  return {
    stream: null,
    warnings,
    capability: INITIAL_CONTROLLER_STATE.mediaCapability,
  };
}

function isActiveRecordingStatus(status: RecordingControllerStatus): boolean {
  return status === "requestingPermission" || status === "recording" || status === "paused";
}

function isFinalizingRecordingStatus(status: RecordingControllerStatus): boolean {
  return status === "stopping" || status === "processing";
}
