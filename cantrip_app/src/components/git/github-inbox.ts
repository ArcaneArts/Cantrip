import type {
  GithubInboxAttention,
  GithubInboxItem,
  GithubInboxView,
  GithubIssueKind,
  GithubIssueState,
} from "@cantrip/protocol";

export interface GithubInboxViewDefinition {
  id: GithubInboxView;
  label: string;
  description: string;
}

const commonViews: readonly GithubInboxViewDefinition[] = [
  { id: "all", label: "All", description: "Everything in this state" },
  {
    id: "assigned-to-me",
    label: "Assigned to me",
    description: "Assigned to the authenticated GitHub user",
  },
  {
    id: "activity",
    label: "Mentions & unread",
    description: "Mentions and unread GitHub notification activity",
  },
  {
    id: "stale",
    label: "Stale",
    description: "No activity in the last 30 days",
  },
];

const pullRequestAttentionViews: readonly GithubInboxViewDefinition[] = [
  {
    id: "needs-review",
    label: "Needs my review",
    description: "Pull requests requesting your review",
  },
  {
    id: "failed-checks",
    label: "Failed checks",
    description: "Pull requests with failing checks",
  },
  {
    id: "merge-conflicts",
    label: "Merge conflicts",
    description: "Pull requests GitHub reports as conflicting",
  },
  {
    id: "approved-ready",
    label: "Approved & ready",
    description: "Approved, mergeable pull requests without blocking checks",
  },
];

export function githubInboxViews(
  kind: GithubIssueKind,
  state: GithubIssueState,
): readonly GithubInboxViewDefinition[] {
  if (kind !== "pull-request" || state !== "open") return commonViews;
  return [
    commonViews[0]!,
    ...pullRequestAttentionViews,
    ...commonViews.slice(1),
  ];
}

export function githubInboxViewIsAvailable(
  view: GithubInboxView,
  kind: GithubIssueKind,
  state: GithubIssueState,
): boolean {
  return githubInboxViews(kind, state).some(({ id }) => id === view);
}

export const githubInboxAttentionLabels: Readonly<
  Record<GithubInboxAttention, string>
> = {
  assigned: "Assigned",
  mention: "Mention",
  "review-requested": "Review requested",
  unread: "Unread",
  "failed-checks": "Checks failed",
  "merge-conflict": "Conflict",
  "approved-ready": "Ready",
  stale: "Stale",
};

export function visibleGithubInboxAttention(
  item: GithubInboxItem,
): GithubInboxAttention[] {
  const preferred: GithubInboxAttention[] = item.pullRequest
    ? [
        "unread",
        "mention",
        "review-requested",
        "failed-checks",
        "merge-conflict",
        "approved-ready",
        "assigned",
        "stale",
      ]
    : ["unread", "mention", "assigned", "stale"];
  return preferred.filter((attention) => item.attention.includes(attention));
}
