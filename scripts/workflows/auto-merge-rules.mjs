export function shouldDeferAutoMergeForForkReview(event, pr) {
  const isReviewEvent = Boolean(event?.review);
  const isForkPr =
    pr?.headRepoFullName &&
    pr?.baseRepoFullName &&
    pr.headRepoFullName !== pr.baseRepoFullName;

  return Boolean(isReviewEvent && isForkPr);
}

export function shouldWaitForRequiredChecks({ requiredChecks, checkRuns }) {
  const byName = new Map((checkRuns ?? []).map((check) => [check.name, check]));
  const missing = [];
  const pending = [];
  const failed = [];

  for (const name of requiredChecks) {
    const check = byName.get(name);
    if (!check) {
      missing.push(name);
    } else if (check.status !== 'completed') {
      pending.push(name);
    } else if (check.conclusion !== 'success') {
      failed.push(name);
    }
  }

  return {
    wait: missing.length > 0 || pending.length > 0 || failed.length > 0,
    missing,
    pending,
    failed,
  };
}
