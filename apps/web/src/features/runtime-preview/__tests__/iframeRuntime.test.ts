import { describe, expect, it } from "vitest";
import { acceptRuntimeMessage } from "../iframeRuntime";

describe("acceptRuntimeMessage — schema + source validation", () => {
  const expected = { runId: "run-1", source: null };

  it("accepts a well-formed console message matching runId", () => {
    const result = acceptRuntimeMessage(
      {
        source: "code-tape-runtime",
        runId: "run-1",
        type: "console",
        payload: { level: "log", args: ["hello"] },
      },
      expected,
    );
    expect(result).not.toBeNull();
    expect(result?.type).toBe("console");
  });

  it("rejects messages with wrong source", () => {
    const result = acceptRuntimeMessage(
      {
        source: "evil-runtime",
        runId: "run-1",
        type: "console",
        payload: { level: "log", args: [] },
      },
      expected,
    );
    expect(result).toBeNull();
  });

  it("rejects messages with mismatching runId", () => {
    const result = acceptRuntimeMessage(
      {
        source: "code-tape-runtime",
        runId: "run-OLD",
        type: "console",
        payload: { level: "log", args: [] },
      },
      expected,
    );
    expect(result).toBeNull();
  });

  it("rejects messages with unknown type", () => {
    const result = acceptRuntimeMessage(
      {
        source: "code-tape-runtime",
        runId: "run-1",
        type: "drop-table",
        payload: {},
      },
      expected,
    );
    expect(result).toBeNull();
  });

  it("rejects messages with malformed payload", () => {
    const result = acceptRuntimeMessage(
      { source: "code-tape-runtime", runId: "run-1", type: "console", payload: "string" },
      expected,
    );
    expect(result).toBeNull();
  });

  it("rejects non-object payloads", () => {
    expect(acceptRuntimeMessage(null, expected)).toBeNull();
    expect(acceptRuntimeMessage("hi", expected)).toBeNull();
    expect(acceptRuntimeMessage(42, expected)).toBeNull();
  });
});
