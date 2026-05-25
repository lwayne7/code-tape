import { describe, expect, it, vi } from "vitest";
import type {
  CompileLanguage,
  CompileResult,
  IframeRunInput,
  IframeRunResult,
  IframeRuntime,
  PreviewCompiler,
} from "@/shared/recording-schema";
import { createEventBus } from "@/features/recorder/eventBus";
import { createRecordingClock } from "@/features/recorder/recordingClock";
import { createRuntimeProducer } from "../runtimeProducer";

function setup(overrides: {
  compile?: PreviewCompiler["compile"];
  run?: IframeRuntime["run"];
} = {}) {
  const clock = createRecordingClock({ nowProvider: () => 1000 });
  const bus = createEventBus({ clock, wallTimeProvider: () => "T" });
  const compile = vi.fn(
    overrides.compile ??
      (async (source: string, _language: CompileLanguage): Promise<CompileResult> => ({
        ok: true,
        code: `compiled:${source}`,
        warnings: [],
      })),
  );
  const run = vi.fn(
    overrides.run ??
      (async (input: IframeRunInput): Promise<IframeRunResult> => ({
        runId: input.runId,
        status: "complete",
        previewHtml: "<body>ok</body>",
        stdout: ["hello"],
        stderr: [],
      })),
  );
  const compiler: PreviewCompiler = { compile };
  const runtime: IframeRuntime = {
    mount: vi.fn(),
    run,
    renderPreview: vi.fn(),
    reset: vi.fn(),
    destroy: vi.fn(),
  };
  const producer = createRuntimeProducer({ bus, clock, compiler, runtime });
  clock.start();
  producer.start();
  return { bus, compile, producer, run, runtime };
}

describe("createRuntimeProducer", () => {
  it("emits run-start then run-output for a successful iframe run", async () => {
    const { bus, compile, producer, run } = setup();

    const result = await producer.trigger({
      language: "javascript",
      source: "console.log('hello')",
    });

    const runInput = run.mock.calls[0]?.[0];
    expect(runInput?.runId).toMatch(/^run-/);
    expect(runInput?.compiledCode).toBe("compiled:console.log('hello')");
    expect(runInput?.timeoutMs).toBe(3000);
    expect(compile).toHaveBeenCalledWith("console.log('hello')", "javascript");
    expect(result).toEqual({
      runId: runInput?.runId,
      status: "complete",
      previewHtml: "<body>ok</body>",
      stdout: ["hello"],
      stderr: [],
    });
    expect(bus.drain().map((event) => ({ type: event.type, payload: event.payload }))).toEqual([
      {
        type: "run-start",
        payload: { language: "javascript", runtime: "iframe", runId: runInput?.runId },
      },
      {
        type: "run-output",
        payload: {
          runId: runInput?.runId,
          stdout: ["hello"],
          stderr: [],
          previewHtml: "<body>ok</body>",
          status: "success",
        },
      },
    ]);
  });

  it("emits run-error with transpile phase when compilation fails", async () => {
    const { bus, producer, run } = setup({
      compile: async (): Promise<CompileResult> => ({
        ok: false,
        phase: "transpile",
        message: "Unexpected token",
        stack: "stacktrace",
      }),
    });

    const result = await producer.trigger({
      language: "typescript",
      source: "const x: = 1",
    });

    expect(run).not.toHaveBeenCalled();
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.phase).toBe("transpile");
      expect(result.message).toBe("Unexpected token");
    }
    expect(bus.drain().map((event) => ({ type: event.type, payload: event.payload }))).toEqual([
      {
        type: "run-start",
        payload: { language: "typescript", runtime: "iframe", runId: result.runId },
      },
      {
        type: "run-error",
        payload: {
          runId: result.runId,
          phase: "transpile",
          message: "Unexpected token",
          stack: "stacktrace",
          stdout: [],
          stderr: [],
          previewHtml: null,
        },
      },
    ]);
  });

  it("emits run-error with runtime phase when iframe run fails", async () => {
    const { bus, producer } = setup({
      run: async (input): Promise<IframeRunResult> => ({
        runId: input.runId,
        status: "error",
        phase: "runtime",
        message: "boom",
        stack: "stacktrace",
        stdout: ["before"],
        stderr: ["warn"],
      }),
    });

    const result = await producer.trigger({ language: "javascript", source: "throw new Error()" });

    expect(result.status).toBe("error");
    expect(bus.drain().map((event) => ({ type: event.type, payload: event.payload }))).toEqual([
      {
        type: "run-start",
        payload: { language: "javascript", runtime: "iframe", runId: result.runId },
      },
      {
        type: "run-error",
        payload: {
          runId: result.runId,
          phase: "runtime",
          message: "boom",
          stack: "stacktrace",
          stdout: ["before"],
          stderr: ["warn"],
          previewHtml: null,
        },
      },
    ]);
  });

  it("emits run-error with runtime phase when iframe run times out", async () => {
    const { bus, producer } = setup({
      run: async (input): Promise<IframeRunResult> => ({
        runId: input.runId,
        status: "timeout",
        stdout: ["partial"],
        stderr: [],
      }),
    });

    const result = await producer.trigger({ language: "javascript", source: "await never()" });

    expect(result.status).toBe("timeout");
    expect(bus.drain().map((event) => ({ type: event.type, payload: event.payload }))).toEqual([
      {
        type: "run-start",
        payload: { language: "javascript", runtime: "iframe", runId: result.runId },
      },
      {
        type: "run-error",
        payload: {
          runId: result.runId,
          phase: "runtime",
          message: "runtime-timeout",
          stdout: ["partial"],
          stderr: [],
          previewHtml: null,
        },
      },
    ]);
  });

  it.each(["pause", "stop", "dispose"] as const)(
    "rejects trigger after %s without emitting runtime events",
    async (method) => {
      const { bus, compile, producer, run } = setup();
      producer[method]();

      await expect(producer.trigger({ language: "javascript", source: "1" })).rejects.toThrow(
        "RuntimeProducer is not active",
      );

      expect(compile).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(bus.drain()).toEqual([]);
    },
  );
});
