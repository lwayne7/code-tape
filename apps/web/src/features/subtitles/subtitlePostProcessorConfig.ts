import { DEFAULT_POSTPROCESSOR_MODEL } from "./subtitlePostProcessor";

export const SUBTITLE_POSTPROCESSOR_MODEL_ENV = "VITE_SUBTITLE_POSTPROCESSOR_MODEL";

type SubtitlePostProcessorEnv = {
  [SUBTITLE_POSTPROCESSOR_MODEL_ENV]?: unknown;
};

export function resolveSubtitlePostProcessorModel(
  env: SubtitlePostProcessorEnv = import.meta.env as SubtitlePostProcessorEnv,
): string {
  const configuredModel = env[SUBTITLE_POSTPROCESSOR_MODEL_ENV];
  if (typeof configuredModel !== "string") return DEFAULT_POSTPROCESSOR_MODEL;
  const trimmedModel = configuredModel.trim();
  return trimmedModel || DEFAULT_POSTPROCESSOR_MODEL;
}
