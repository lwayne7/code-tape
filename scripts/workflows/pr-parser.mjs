const closingKeywordPattern = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;
const crClaimSignals = new Set(['CR认领', 'CR通过']);
const ignoredClaimBodies = new Set(['确认合并']);
const ignoredReviewerLogins = new Set(['github-actions[bot]']);

export function parseClosingIssues(body = '') {
  const issues = [];
  for (const match of body.matchAll(closingKeywordPattern)) {
    issues.push(Number(match[1]));
  }
  return [...new Set(issues)];
}

export function requireSingleClosingIssue(body = '') {
  const issues = parseClosingIssues(body);
  if (issues.length !== 1) {
    throw new Error(`expected exactly one closing issue, got ${issues.length}`);
  }
  return issues[0];
}

function commentLogin(comment) {
  return comment?.user?.login;
}

function commentBody(comment) {
  return comment?.body?.trim() ?? '';
}

function commentCreatedAt(comment) {
  return comment?.created_at || comment?.createdAt || comment?.submitted_at || comment?.submittedAt;
}

function hasCrPassFrom(items, login) {
  return items.some((item) => commentLogin(item) === login && commentBody(item) === 'CR通过');
}

function isEligibleReviewerComment(comment, prAuthor) {
  const login = commentLogin(comment);
  const type = comment?.user?.type;
  return Boolean(login) && login !== prAuthor && type !== 'Bot' && !ignoredReviewerLogins.has(login);
}

function isWorkflowMaintenanceComment(comment) {
  const body = commentBody(comment);
  return ignoredClaimBodies.has(body) || body.includes('repo-guard');
}

function eventTime(comment) {
  const timestamp = Date.parse(commentCreatedAt(comment) ?? '');
  return Number.isNaN(timestamp) ? Number.POSITIVE_INFINITY : timestamp;
}

function isEligibleClaimComment(comment, prAuthor) {
  return isEligibleReviewerComment(comment, prAuthor) && !isWorkflowMaintenanceComment(comment);
}

function isEligibleReviewClaim(review, prAuthor) {
  return isEligibleClaimComment(review, prAuthor) && crClaimSignals.has(commentBody(review));
}

export function findClaimedReviewer({ comments = [], reviews = [], reviewComments = [], prAuthor }) {
  const claimEvents = [
    ...comments.filter((comment) => isEligibleClaimComment(comment, prAuthor)),
    ...reviews.filter((review) => isEligibleReviewClaim(review, prAuthor)),
    ...reviewComments.filter((comment) => isEligibleClaimComment(comment, prAuthor)),
  ].sort((a, b) => eventTime(a) - eventTime(b));

  return commentLogin(claimEvents[0]) ?? null;
}

export function findValidReviewer({ comments = [], reviews = [], reviewComments = [], prAuthor }) {
  const claimedReviewer = findClaimedReviewer({ comments, reviews, reviewComments, prAuthor });
  if (!claimedReviewer) {
    return null;
  }

  const hasPass =
    hasCrPassFrom(comments, claimedReviewer) ||
    hasCrPassFrom(reviews, claimedReviewer) ||
    hasCrPassFrom(reviewComments, claimedReviewer);

  return hasPass ? claimedReviewer : null;
}

export function isTimedOut(createdAt, now, hours = 24) {
  return Date.parse(now) - Date.parse(createdAt) > hours * 60 * 60 * 1000;
}
