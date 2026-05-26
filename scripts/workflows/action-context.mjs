import { parseClosingIssues } from './pr-parser.mjs';
import { readProgress } from './progress-store.mjs';

export function pullNumberFromEvent(event) {
  if (event.pull_request?.number) {
    return event.pull_request.number;
  }
  if (event.issue?.pull_request && event.issue?.number) {
    return event.issue.number;
  }
  if (event.review?.pull_request_url) {
    const match = event.review.pull_request_url.match(/\/pulls\/(\d+)$/);
    if (match) {
      return Number(match[1]);
    }
  }
  if (event.workflow_run?.pull_requests?.[0]?.number) {
    return event.workflow_run.pull_requests[0].number;
  }
  return null;
}

export async function resolvePullNumberFromEvent(client, event) {
  const directPullNumber = pullNumberFromEvent(event);
  if (directPullNumber) {
    return directPullNumber;
  }

  const workflowRunHeadSha = event.workflow_run?.head_sha;
  if (!workflowRunHeadSha) {
    return null;
  }

  const matchingPull = (await client.listOpenPulls()).find(
    (pull) => pull?.head?.sha === workflowRunHeadSha,
  );
  return matchingPull?.number ?? null;
}

export async function loadPrGuardContext(client, event) {
  const prNumber = await resolvePullNumberFromEvent(client, event);
  if (!prNumber) {
    throw new Error('event does not reference a pull request');
  }
  return loadPrGuardContextForPull(client, prNumber);
}

export async function loadPrGuardContextForPull(client, prNumber) {
  const pr = await client.getPull(prNumber);
  const closingIssues = parseClosingIssues(pr.body ?? '');
  const issueNumber = closingIssues.length === 1 ? closingIssues[0] : null;
  const issue = issueNumber ? await client.getIssue(issueNumber) : null;
  const [changedFiles, reviews, reviewComments, comments, commit, progress] = await Promise.all([
    client.listPullFiles(prNumber),
    client.listPullReviews(prNumber),
    client.listPullReviewComments(prNumber),
    client.listIssueComments(prNumber),
    client.getCommit(pr.head.sha),
    readProgress(),
  ]);

  return {
    progress,
    rawPull: pr,
    rawIssue: issue,
    pr: {
      number: pr.number,
      title: pr.title,
      body: pr.body ?? '',
      author: pr.user.login,
      createdAt: pr.created_at,
      latestCommitAt: commit?.commit?.committer?.date ?? pr.updated_at,
      headRepoFullName: pr.head.repo?.full_name,
      headRef: pr.head.ref,
      baseRepoFullName: pr.base.repo?.full_name,
    },
    issue: issue
      ? {
          number: issue.number,
          labels: issue.labels,
          assignee: issue.assignee?.login,
        }
      : null,
    changedFiles,
    reviews,
    reviewComments,
    comments,
  };
}
