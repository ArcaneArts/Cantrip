import {
  githubInboxItemSchema,
  githubInboxListSchema,
  type GithubInboxAttention,
  type GithubInboxItem,
  type GithubInboxList,
  type GithubInboxView,
  type GithubIssueKind,
  type GithubIssueState,
} from "@cantrip/protocol";

interface GithubApiNotification {
  reason?: unknown;
  subject?: unknown;
  unread?: unknown;
}

interface GithubGraphqlInboxNode {
  __typename?: unknown;
  assignees?: unknown;
  author?: unknown;
  baseRefName?: unknown;
  closedAt?: unknown;
  comments?: unknown;
  commits?: unknown;
  createdAt?: unknown;
  headRefName?: unknown;
  isDraft?: unknown;
  labels?: unknown;
  mergeable?: unknown;
  number?: unknown;
  reviewDecision?: unknown;
  reviewRequests?: unknown;
  state?: unknown;
  title?: unknown;
  updatedAt?: unknown;
  url?: unknown;
}

interface GithubInboxNotification {
  number: number;
  reason: string;
  unread: boolean;
}

type GithubApi = (pathname: string, args?: string[]) => Promise<unknown>;

function githubLogin(value: unknown): string {
  if (
    value &&
    typeof value === "object" &&
    "login" in value &&
    typeof value.login === "string"
  ) {
    return value.login;
  }
  return "ghost";
}

function graphqlNodes(value: unknown): unknown[] {
  if (!value || typeof value !== "object" || !("nodes" in value)) return [];
  return Array.isArray(value.nodes) ? value.nodes : [];
}

function graphqlTotalCount(value: unknown): number {
  if (!value || typeof value !== "object" || !("totalCount" in value)) {
    return 0;
  }
  return Number(value.totalCount) || 0;
}

function inboxAssignees(value: GithubGraphqlInboxNode): string[] {
  return graphqlNodes(value.assignees)
    .map(githubLogin)
    .filter((login) => login !== "ghost")
    .slice(0, 100);
}

function inboxLabels(value: GithubGraphqlInboxNode) {
  return graphqlNodes(value.labels).flatMap((label) => {
    if (!label || typeof label !== "object") return [];
    const name = "name" in label ? label.name : null;
    const color = "color" in label ? label.color : null;
    return typeof name === "string" && typeof color === "string"
      ? [{ name, color }]
      : [];
  });
}

function inboxReviewRequests(value: GithubGraphqlInboxNode): string[] {
  return graphqlNodes(value.reviewRequests).flatMap((request) => {
    if (!request || typeof request !== "object") return [];
    const reviewer =
      "requestedReviewer" in request ? request.requestedReviewer : null;
    if (!reviewer || typeof reviewer !== "object") return [];
    if ("login" in reviewer && typeof reviewer.login === "string") {
      return [reviewer.login];
    }
    return [];
  });
}

function inboxChecksState(
  value: GithubGraphqlInboxNode,
): "success" | "failure" | "pending" | "neutral" | "none" {
  const commitNodes = graphqlNodes(value.commits);
  const lastCommit = commitNodes.at(-1);
  if (
    !lastCommit ||
    typeof lastCommit !== "object" ||
    !("commit" in lastCommit)
  ) {
    return "none";
  }
  const commit = lastCommit.commit;
  if (
    !commit ||
    typeof commit !== "object" ||
    !("statusCheckRollup" in commit)
  ) {
    return "none";
  }
  const rollup = commit.statusCheckRollup;
  if (!rollup || typeof rollup !== "object" || !("state" in rollup)) {
    return "none";
  }
  switch (rollup.state) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
      return "failure";
    case "EXPECTED":
    case "PENDING":
      return "pending";
    default:
      return "neutral";
  }
}

function inboxMergeable(
  value: unknown,
): "mergeable" | "conflicting" | "unknown" {
  return value === "MERGEABLE"
    ? "mergeable"
    : value === "CONFLICTING"
      ? "conflicting"
      : "unknown";
}

function inboxReviewDecision(
  value: unknown,
): "approved" | "changes-requested" | "review-required" | "none" {
  return value === "APPROVED"
    ? "approved"
    : value === "CHANGES_REQUESTED"
      ? "changes-requested"
      : value === "REVIEW_REQUIRED"
        ? "review-required"
        : "none";
}

function notificationNumber(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /\/(?:issues|pulls)\/(\d+)$/u.exec(value);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function parseNotification(
  value: GithubApiNotification,
  kind: GithubIssueKind,
): GithubInboxNotification | null {
  if (!value.subject || typeof value.subject !== "object") return null;
  const subject = value.subject as { type?: unknown; url?: unknown };
  const expectedType = kind === "pull-request" ? "PullRequest" : "Issue";
  if (subject.type !== expectedType) return null;
  const number = notificationNumber(subject.url);
  if (!number) return null;
  return {
    number,
    reason: typeof value.reason === "string" ? value.reason : "unknown",
    unread: value.unread === true,
  };
}

function notificationAttention(
  notification: GithubInboxNotification | undefined,
): GithubInboxAttention[] {
  if (!notification) return [];
  const attention: GithubInboxAttention[] = [];
  if (notification.unread) attention.push("unread");
  if (["mention", "team_mention"].includes(notification.reason)) {
    attention.push("mention");
  }
  if (notification.reason === "review_requested") {
    attention.push("review-requested");
  }
  if (notification.reason === "assign") attention.push("assigned");
  return attention;
}

const GITHUB_INBOX_STALE_DAYS = 30;

const GITHUB_INBOX_SEARCH_QUERY = `
  query CantripInbox($searchQuery: String!, $first: Int!, $after: String) {
    search(query: $searchQuery, type: ISSUE, first: $first, after: $after) {
      issueCount
      pageInfo { endCursor hasNextPage }
      nodes {
        ... on Issue {
          __typename number title state url author { login }
          comments { totalCount }
          labels(first: 20) { nodes { name color } }
          assignees(first: 20) { nodes { login } }
          createdAt updatedAt closedAt
        }
        ... on PullRequest {
          __typename number title state url author { login }
          comments { totalCount }
          labels(first: 20) { nodes { name color } }
          assignees(first: 20) { nodes { login } }
          createdAt updatedAt closedAt
          isDraft headRefName baseRefName mergeable reviewDecision
          reviewRequests(first: 100) {
            nodes { requestedReviewer { ... on User { login } } }
          }
          commits(last: 1) {
            nodes { commit { statusCheckRollup { state } } }
          }
        }
      }
    }
  }
`;

const GITHUB_INBOX_ACTIVITY_FIELDS = `
  __typename
  ... on Issue {
    __typename number title state url author { login }
    comments { totalCount }
    labels(first: 20) { nodes { name color } }
    assignees(first: 20) { nodes { login } }
    createdAt updatedAt closedAt
  }
  ... on PullRequest {
    __typename number title state url author { login }
    comments { totalCount }
    labels(first: 20) { nodes { name color } }
    assignees(first: 20) { nodes { login } }
    createdAt updatedAt closedAt
    isDraft headRefName baseRefName mergeable reviewDecision
    reviewRequests(first: 100) {
      nodes { requestedReviewer { ... on User { login } } }
    }
    commits(last: 1) {
      nodes { commit { statusCheckRollup { state } } }
    }
  }
`;

function staleCutoff(now = new Date()): string {
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - GITHUB_INBOX_STALE_DAYS);
  return cutoff.toISOString().slice(0, 10);
}

export function githubInboxSearchQuery(
  nameWithOwner: string,
  kind: GithubIssueKind,
  state: GithubIssueState,
  view: GithubInboxView,
): string {
  const qualifiers = [
    `repo:${nameWithOwner}`,
    kind === "pull-request" ? "is:pr" : "is:issue",
    `is:${state}`,
  ];
  switch (view) {
    case "needs-review":
      qualifiers.push("review-requested:@me");
      break;
    case "failed-checks":
      qualifiers.push("status:failure");
      break;
    case "approved-ready":
      // Pull requests with no checks can still be ready. Fetch every approved,
      // non-draft candidate and let the rich state filter reject failures,
      // pending checks, conflicts, and unknown mergeability below.
      qualifiers.push("review:approved", "-is:draft");
      break;
    case "stale":
      qualifiers.push(`updated:<${staleCutoff()}`);
      break;
    case "assigned-to-me":
      qualifiers.push("assignee:@me");
      break;
    case "activity":
      qualifiers.push("mentions:@me");
      break;
    case "all":
    case "merge-conflicts":
      break;
  }
  return qualifiers.join(" ");
}

function parseInboxItem(
  value: GithubGraphqlInboxNode,
  viewerLogin: string,
  notification: GithubInboxNotification | undefined,
): GithubInboxItem | null {
  const kind =
    value.__typename === "PullRequest"
      ? "pull-request"
      : value.__typename === "Issue"
        ? "issue"
        : null;
  if (!kind) return null;
  const assignees = inboxAssignees(value);
  const attention = notificationAttention(notification);
  if (assignees.includes(viewerLogin)) attention.push("assigned");
  const updatedAt = String(value.updatedAt);
  if (updatedAt.slice(0, 10) < staleCutoff()) attention.push("stale");

  let pullRequest: GithubInboxItem["pullRequest"] = null;
  if (kind === "pull-request") {
    const checksState = inboxChecksState(value);
    const mergeable = inboxMergeable(value.mergeable);
    const reviewDecision = inboxReviewDecision(value.reviewDecision);
    if (inboxReviewRequests(value).includes(viewerLogin)) {
      attention.push("review-requested");
    }
    if (checksState === "failure") attention.push("failed-checks");
    if (mergeable === "conflicting") attention.push("merge-conflict");
    if (
      value.isDraft !== true &&
      reviewDecision === "approved" &&
      mergeable === "mergeable" &&
      !["failure", "pending"].includes(checksState)
    ) {
      attention.push("approved-ready");
    }
    pullRequest = {
      draft: value.isDraft === true,
      headRef:
        typeof value.headRefName === "string" ? value.headRefName : "unknown",
      baseRef:
        typeof value.baseRefName === "string" ? value.baseRefName : "unknown",
      mergeable,
      reviewDecision,
      checksState,
    };
  }

  return githubInboxItemSchema.parse({
    number: Number(value.number),
    title: String(value.title),
    state: value.state === "OPEN" ? "open" : "closed",
    url: String(value.url),
    author: githubLogin(value.author),
    commentCount: graphqlTotalCount(value.comments),
    labels: inboxLabels(value),
    createdAt: String(value.createdAt),
    updatedAt,
    closedAt: typeof value.closedAt === "string" ? value.closedAt : null,
    kind,
    assignees,
    attention: [...new Set(attention)],
    pullRequest,
  });
}

async function notifications(
  api: GithubApi,
  apiRepositoryPath: string,
  kind: GithubIssueKind,
): Promise<{
  available: boolean;
  notifications: GithubInboxNotification[];
}> {
  try {
    const values = (await api(`${apiRepositoryPath}/notifications`, [
      "--method",
      "GET",
      "-f",
      "all=true",
      "-f",
      "participating=false",
      "-f",
      "per_page=50",
    ])) as GithubApiNotification[];
    return {
      available: true,
      notifications: Array.isArray(values)
        ? values.flatMap((value) => {
            const parsed = parseNotification(value, kind);
            return parsed ? [parsed] : [];
          })
        : [],
    };
  } catch {
    // Fine-grained tokens cannot always read notifications. Mention search
    // remains available, so notification access must not block the inbox.
    return { available: false, notifications: [] };
  }
}

async function search(
  api: GithubApi,
  input: {
    cursor: string | null;
    kind: GithubIssueKind;
    limit: number;
    repository: string;
    state: GithubIssueState;
    view: GithubInboxView;
  },
): Promise<{
  nodes: GithubGraphqlInboxNode[];
  total: number;
  nextCursor: string | null;
}> {
  const args = [
    "-f",
    `query=${GITHUB_INBOX_SEARCH_QUERY}`,
    "-F",
    `searchQuery=${githubInboxSearchQuery(input.repository, input.kind, input.state, input.view)}`,
    "-F",
    `first=${input.limit}`,
  ];
  if (input.cursor) args.push("-F", `after=${input.cursor}`);
  const value = (await api("graphql", args)) as {
    data?: { search?: unknown };
  };
  const result = value.data?.search;
  if (!result || typeof result !== "object") {
    throw new Error("GitHub returned an invalid inbox search result.");
  }
  const pageInfo =
    "pageInfo" in result &&
    result.pageInfo &&
    typeof result.pageInfo === "object"
      ? (result.pageInfo as { endCursor?: unknown; hasNextPage?: unknown })
      : {};
  return {
    nodes: graphqlNodes(result).filter(
      (node): node is GithubGraphqlInboxNode =>
        Boolean(node) && typeof node === "object",
    ),
    total: "issueCount" in result ? Number(result.issueCount) || 0 : 0,
    nextCursor:
      pageInfo.hasNextPage === true && typeof pageInfo.endCursor === "string"
        ? pageInfo.endCursor
        : null,
  };
}

async function activity(
  api: GithubApi,
  repository: string,
  source: GithubInboxNotification[],
): Promise<GithubGraphqlInboxNode[]> {
  const [owner, name] = repository.split("/");
  if (!owner || !name) throw new Error("Invalid GitHub repository name.");
  const uniqueNumbers = [...new Set(source.map(({ number }) => number))].slice(
    0,
    50,
  );
  if (uniqueNumbers.length === 0) return [];
  const selections = uniqueNumbers
    .map(
      (number, index) =>
        `item${index}: issueOrPullRequest(number: ${number}) { ${GITHUB_INBOX_ACTIVITY_FIELDS} }`,
    )
    .join("\n");
  const query = `
    query CantripInboxActivity($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) { ${selections} }
    }
  `;
  const value = (await api("graphql", [
    "-f",
    `query=${query}`,
    "-F",
    `owner=${owner}`,
    "-F",
    `name=${name}`,
  ])) as { data?: { repository?: unknown } };
  const repositoryResult = value.data?.repository;
  if (!repositoryResult || typeof repositoryResult !== "object") {
    throw new Error("GitHub returned an invalid activity result.");
  }
  return uniqueNumbers.flatMap((_, index) => {
    const node = (repositoryResult as Record<string, unknown>)[`item${index}`];
    return node && typeof node === "object"
      ? [node as GithubGraphqlInboxNode]
      : [];
  });
}

export async function loadGithubInbox(input: {
  api: GithubApi;
  apiRepositoryPath: string;
  cursor: string | null;
  kind: GithubIssueKind;
  limit: number;
  repository: string;
  state: GithubIssueState;
  view: GithubInboxView;
  viewerLogin: string;
}): Promise<GithubInboxList> {
  const notificationState = await notifications(
    input.api,
    input.apiRepositoryPath,
    input.kind,
  );
  const notificationsByNumber = new Map(
    notificationState.notifications.map((notification) => [
      notification.number,
      notification,
    ]),
  );

  let nodes: GithubGraphqlInboxNode[];
  let total: number | null;
  let nextCursor: string | null;
  if (input.view === "activity" && notificationState.available) {
    const relevantNotifications = notificationState.notifications.filter(
      ({ reason, unread }) =>
        unread || ["mention", "team_mention"].includes(reason),
    );
    nodes = await activity(input.api, input.repository, relevantNotifications);
    total = nodes.length;
    nextCursor = null;
  } else {
    const result = await search(input.api, input);
    nodes = result.nodes;
    total = result.total;
    nextCursor = result.nextCursor;
  }

  let items = nodes.flatMap((node) => {
    const number = Number(node.number);
    const parsed = parseInboxItem(
      node,
      input.viewerLogin,
      notificationsByNumber.get(number),
    );
    return parsed && parsed.kind === input.kind && parsed.state === input.state
      ? [parsed]
      : [];
  });
  if (input.view === "merge-conflicts") {
    items = items.filter(({ attention }) =>
      attention.includes("merge-conflict"),
    );
    total = null;
  } else if (input.view === "approved-ready") {
    items = items.filter(({ attention }) =>
      attention.includes("approved-ready"),
    );
    total = null;
  } else if (input.view === "activity" && !notificationState.available) {
    items = items.map((item) => ({
      ...item,
      attention: [...new Set([...item.attention, "mention" as const])],
    }));
  }

  return githubInboxListSchema.parse({
    kind: input.kind,
    state: input.state,
    view: input.view,
    total,
    items,
    nextCursor,
    viewerLogin: input.viewerLogin,
    activityAvailable: notificationState.available,
  });
}
