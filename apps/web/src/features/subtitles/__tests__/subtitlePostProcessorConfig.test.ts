import { describe, expect, it } from "vitest";
import { DEFAULT_POSTPROCESSOR_MODEL } from "../subtitlePostProcessor";
import { resolveSubtitlePostProcessorModel } from "../subtitlePostProcessorConfig";

describe("resolveSubtitlePostProcessorModel", () => {
  it("uses the public Hugging Face model configured for subtitle post-processing", () => {
    expect(
      resolveSubtitlePostProcessorModel({
        VITE_SUBTITLE_POSTPROCESSOR_MODEL: " onnx-community/Qwen2.5-0.5B-Instruct ",
      }),
    ).toBe("onnx-community/Qwen2.5-0.5B-Instruct");
  });

  it("falls back to the best-fit public browser-local model when no override is configured", () => {
    expect(resolveSubtitlePostProcessorModel({})).toBe(DEFAULT_POSTPROCESSOR_MODEL);
    expect(resolveSubtitlePostProcessorModel({ VITE_SUBTITLE_POSTPROCESSOR_MODEL: " " })).toBe(
      DEFAULT_POSTPROCESSOR_MODEL,
    );
  });
});
