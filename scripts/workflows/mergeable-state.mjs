const waitingMergeableStates = new Set(['blocked', 'dirty', 'unstable']);

export function shouldWaitForMergeableState(state) {
  if (!state) {
    return false;
  }
  return waitingMergeableStates.has(state);
}
