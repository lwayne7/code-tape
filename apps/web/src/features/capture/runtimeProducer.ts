import type {
  CreateRuntimeProducer,
  RuntimeProducerHandle,
  RuntimeProducerRunResult,
} from "./types";
import type { CompileResult, IframeRunResult, RunErrorPayload } from "@/shared/recording-schema";
import { generateId } from "@/shared/util/ids";

const RUNTIME_TIMEOUT_MS = 3000;

/**
 * RuntimeProducer — emits run-start / run-output / run-error.
 *
 * STUB. Real implementation belongs to issue `[P0] runtimeProducer 实装`.
 *
 * 实装时需要：
 *   - trigger(input):
 *     1. 生成 runId（用 shared/util/ids.generateId("run")）
 *     2. emit run-start { language, runtime: "iframe", runId }
 *     3. await compiler.compile(source, language)
 *        - 失败：emit run-error { phase: "transpile", message, stack, previewHtml: null }
 *     4. 成功后 await runtime.run({ runId, compiledCode, timeoutMs: 5000 })
 *        - status === "complete"：emit run-output（stdout/stderr/previewHtml）
 *        - status === "error"  ：emit run-error { phase: "runtime", ... }
 *        - status === "timeout"：emit run-error { phase: "runtime", message: "timeout" }
 *   - pause() 期间禁用 trigger（按钮在 UI 层应禁用，producer 双重防御）
 */
function errorInfo(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) return { message: err.message, stack: err.stack };
  return { message: String(err) };
}

export const createRuntimeProducer: CreateRuntimeProducer = (deps): RuntimeProducerHandle => {
  const { bus, compiler, runtime } = deps;
  let paused = false;
  let stopped = false;
  let disposed = false;

  const assertActive = () => {
    if (paused || stopped || disposed) throw new Error("RuntimeProducer is not active");
  };

  const emitRunError = (payload: RunErrorPayload) => {
    bus.emit({
      type: "run-error",
      source: "runtime",
      track: "runtime",
      payload,
    });
  };

  const emitCompileError = (
    runId: string,
    error: Extract<CompileResult, { ok: false }>,
  ): RuntimeProducerRunResult => {
    const result: RuntimeProducerRunResult = {
      runId,
      status: "error",
      phase: "transpile",
      message: error.message,
      stack: error.stack,
      stdout: [],
      stderr: [],
      previewHtml: null,
    };
    emitRunError({
      runId,
      phase: result.phase,
      message: result.message,
      stack: result.stack,
      stdout: result.stdout,
      stderr: result.stderr,
      previewHtml: result.previewHtml,
    });
    return result;
  };

  const emitRuntimeThrownError = (runId: string, err: unknown): IframeRunResult => {
    const info = errorInfo(err);
    const result: IframeRunResult = {
      runId,
      status: "error",
      phase: "runtime",
      message: info.message,
      stack: info.stack,
      stdout: [],
      stderr: [],
    };
    emitRunError({ ...result, previewHtml: null });
    return result;
  };

  return {
    start() {
      if (disposed) return;
      paused = false;
      stopped = false;
    },
    pause() {
      if (stopped || disposed) return;
      paused = true;
    },
    resume() {
      if (stopped || disposed) return;
      paused = false;
    },
    stop() {
      stopped = true;
      paused = false;
    },
    dispose() {
      disposed = true;
      stopped = true;
      paused = false;
    },
    async trigger(input): Promise<RuntimeProducerRunResult> {
      assertActive();

      const runId = generateId("run");
      bus.emit({
        type: "run-start",
        source: "runtime",
        track: "runtime",
        payload: {
          language: input.language,
          runtime: "iframe",
          runId,
        },
      });

      let compiled: CompileResult;
      try {
        compiled = await compiler.compile(input.source, input.language);
      } catch (err) {
        return emitCompileError(runId, { ok: false, phase: "transpile", ...errorInfo(err) });
      }
      if (!compiled.ok) return emitCompileError(runId, compiled);

      let result: IframeRunResult;
      try {
        result = await runtime.run({
          runId,
          compiledCode: compiled.code,
          timeoutMs: RUNTIME_TIMEOUT_MS,
        });
      } catch (err) {
        return emitRuntimeThrownError(runId, err);
      }

      if (result.status === "complete") {
        bus.emit({
          type: "run-output",
          source: "runtime",
          track: "runtime",
          payload: {
            runId,
            stdout: result.stdout,
            stderr: result.stderr,
            previewHtml: result.previewHtml,
            status: "success",
          },
        });
        return result;
      }

      if (result.status === "timeout") {
        emitRunError({
          runId,
          phase: "runtime",
          message: "runtime-timeout",
          stdout: result.stdout,
          stderr: result.stderr,
          previewHtml: null,
        });
        return result;
      }

      emitRunError({
        runId,
        phase: "runtime",
        message: result.message,
        stack: result.stack,
        stdout: result.stdout,
        stderr: result.stderr,
        previewHtml: null,
      });
      return result;
    },
  };
};
