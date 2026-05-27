import type { RecordingPackageV1, ReplayStableState } from "@/shared/recording-schema";
import {
  buildInitialReplayStateFromPackage,
  cloneReplayStableState,
} from "@/shared/recording-schema";

/** Compute the t=0 ReplayStableState before any event has been applied. */
export function buildInitialState(pkg: RecordingPackageV1): ReplayStableState {
  return buildInitialReplayStateFromPackage(pkg);
}

export function cloneState(state: ReplayStableState): ReplayStableState {
  return cloneReplayStableState(state);
}
