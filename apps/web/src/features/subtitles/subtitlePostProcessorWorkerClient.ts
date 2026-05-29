import { DEFAULT_POSTPROCESSOR_MODEL } from "./subtitlePostProcessorConfig";
import type {
  SubtitleCorrectionResult,
  SubtitlePostProcessor,
  SubtitlePostProcessorContext,
  SubtitleTrack,
} from "./types";

type SerializablePostProcessorInput = {
  track: SubtitleTrack;
  context?: SubtitlePostProcessorContext;
};

type WorkerRequest =
  | {
      id: string;
      type: "warmUp";
      model: string;
    }
  | {
      id: string;
      type: "process";
      model: string;
      input: SerializablePostProcessorInput;
    }
  | {
      id: string;
      type: "abort";
    };

type WorkerCommand =
  | {
      type: "warmUp";
    }
  | {
      type: "process";
      input: SerializablePostProcessorInput;
    };

type WorkerResponse =
  | {
      id: string;
      type: "success";
      result?: SubtitleCorrectionResult;
    }
  | {
      id: string;
      type: "error";
      error: SerializedWorkerError;
    };

type SerializedWorkerError = {
  name: string;
  message: string;
};

type PendingRequest = {
  resolve(result: SubtitleCorrectionResult | undefined): void;
  reject(error: unknown): void;
};

export type WorkerBackedSubtitlePostProcessorOptions = {
  model?: string;
  workerFactory?: () => Worker;
};

export function createWorkerBackedHuggingFaceSubtitlePostProcessor(
  options: WorkerBackedSubtitlePostProcessorOptions = {},
): SubtitlePostProcessor {
  const model = options.model ?? DEFAULT_POSTPROCESSOR_MODEL;
  const pendingRequests = new Map<string, PendingRequest>();
  let worker: Worker | null = null;
  let workerPromise: Promise<Worker> | null = null;
  let nextRequestId = 0;

  const ensureWorker = () => {
    if (worker) return Promise.resolve(worker);
    if (!workerPromise) {
      workerPromise = loadWorker(options.workerFactory)
        .then((loadedWorker) => {
          worker = loadedWorker;
          worker.addEventListener("message", handleWorkerMessage);
          worker.addEventListener("error", handleWorkerError);
          worker.addEventListener("messageerror", handleWorkerError);
          return worker;
        })
        .catch((error: unknown) => {
          workerPromise = null;
          throw error;
        });
    }
    return workerPromise;
  };

  const postRequest = async (
    request: WorkerCommand,
    signal?: AbortSignal,
  ): Promise<SubtitleCorrectionResult | undefined> => {
    if (signal?.aborted) throw createAbortError();
    const activeWorker = await ensureWorker();
    if (signal?.aborted) throw createAbortError();
    const id = `subtitle-postprocess-${nextRequestId}`;
    nextRequestId += 1;
    const message = { ...request, id, model } as WorkerRequest;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        pendingRequests.delete(id);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        const abortError = createAbortError();
        cleanup();
        reject(abortError);
        activeWorker.postMessage({ id, type: "abort" } satisfies WorkerRequest);
        terminateWorker(abortError);
      };
      pendingRequests.set(id, {
        resolve(result) {
          cleanup();
          resolve(result);
        },
        reject(error) {
          cleanup();
          reject(error);
        },
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      activeWorker.postMessage(message);
    });
  };

  const terminateWorker = (error: unknown) => {
    for (const pending of pendingRequests.values()) {
      pending.reject(error);
    }
    pendingRequests.clear();
    worker?.terminate();
    worker = null;
    workerPromise = null;
  };

  function handleWorkerMessage(event: MessageEvent<WorkerResponse>) {
    const response = event.data;
    const pending = pendingRequests.get(response.id);
    if (!pending) return;
    if (response.type === "success") {
      pending.resolve(response.result);
      return;
    }
    pending.reject(deserializeWorkerError(response.error));
  }

  function handleWorkerError(event: Event | ErrorEvent) {
    const message =
      "message" in event && typeof event.message === "string"
        ? event.message
        : "字幕 LLM worker 执行失败";
    terminateWorker(new Error(message));
  }

  return {
    async warmUp() {
      await postRequest({ type: "warmUp" });
    },
    async process(input) {
      const result = await postRequest(
        {
          type: "process",
          input: {
            track: input.track,
            context: input.context,
          },
        },
        input.signal,
      );
      if (!result) throw new Error("字幕 LLM worker 未返回纠错结果");
      return result;
    },
  };
}

async function loadWorker(workerFactory?: () => Worker): Promise<Worker> {
  if (workerFactory) return workerFactory();
  const workerModule = await import("./subtitlePostProcessorWorker?worker");
  return new workerModule.default();
}

function deserializeWorkerError(error: SerializedWorkerError): Error {
  const deserialized = new Error(error.message);
  deserialized.name = error.name || "Error";
  return deserialized;
}

function createAbortError(): DOMException {
  return new DOMException("字幕纠错已取消", "AbortError");
}
