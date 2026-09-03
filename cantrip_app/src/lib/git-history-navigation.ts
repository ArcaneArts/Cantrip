import type {
  GitComparisonMode,
  GitHistoryFilter,
  GitHistoryOptions,
} from "@cantrip/protocol";
import { gitHistoryOptionsSchema } from "@cantrip/protocol";

const parameterNames = {
  projectId: "gitProject",
  worktreeId: "gitWorktree",
  commit: "gitCommit",
  selectedCommits: "gitSelected",
  compareLeft: "gitCompareA",
  compareRight: "gitCompareB",
  compareMode: "gitCompareMode",
  filePath: "gitFile",
  message: "gitMessage",
  author: "gitAuthor",
  hash: "gitHash",
  dateFrom: "gitFrom",
  dateTo: "gitTo",
  path: "gitPath",
  branch: "gitBranch",
  tag: "gitTag",
  firstParent: "gitFirstParent",
  hideMerges: "gitHideMerges",
} as const;

const allParameterNames = Object.values(parameterNames);

export const emptyGitHistoryFilter: GitHistoryFilter = {
  message: null,
  author: null,
  hash: null,
  dateFrom: null,
  dateTo: null,
  path: null,
  branch: null,
  tag: null,
};

export const defaultGitHistoryOptions: GitHistoryOptions = {
  filters: emptyGitHistoryFilter,
  firstParent: false,
  hideMerges: false,
};

export interface GitHistoryRouteState {
  projectId: string | null;
  worktreeId: string | null;
  commit: string | null;
  selectedCommits: string[];
  comparison: {
    left: string;
    right: string;
    mode: GitComparisonMode;
  } | null;
  filePath: string | null;
  options: GitHistoryOptions;
}

function value(search: URLSearchParams, key: keyof typeof parameterNames) {
  return search.get(parameterNames[key])?.trim() || null;
}

export function parseGitHistoryRoute(
  input: string | URLSearchParams,
): GitHistoryRouteState {
  const search =
    typeof input === "string"
      ? new URLSearchParams(input.startsWith("?") ? input.slice(1) : input)
      : input;
  const compareLeft = value(search, "compareLeft");
  const compareRight = value(search, "compareRight");
  const compareMode = value(search, "compareMode");
  const selectedCommits = (value(search, "selectedCommits") ?? "")
    .split(",")
    .filter((revision) => /^[0-9a-f]{40,64}$/u.test(revision));
  const options = gitHistoryOptionsSchema.safeParse({
    filters: {
      message: value(search, "message"),
      author: value(search, "author"),
      hash: value(search, "hash"),
      dateFrom: value(search, "dateFrom"),
      dateTo: value(search, "dateTo"),
      path: value(search, "path"),
      branch: value(search, "branch"),
      tag: value(search, "tag"),
    },
    firstParent: search.get(parameterNames.firstParent) === "1",
    hideMerges: search.get(parameterNames.hideMerges) === "1",
  });
  return {
    projectId: value(search, "projectId"),
    worktreeId: value(search, "worktreeId"),
    commit: value(search, "commit"),
    selectedCommits,
    comparison:
      compareLeft && compareRight
        ? {
            left: compareLeft,
            right: compareRight,
            mode: compareMode === "merge-base" ? "merge-base" : "direct",
          }
        : null,
    filePath: value(search, "filePath"),
    options: options.success ? options.data : defaultGitHistoryOptions,
  };
}

export function gitHistoryRouteSearch(
  currentSearch: string | URLSearchParams,
  state: GitHistoryRouteState,
): string {
  const search =
    typeof currentSearch === "string"
      ? new URLSearchParams(
          currentSearch.startsWith("?")
            ? currentSearch.slice(1)
            : currentSearch,
        )
      : new URLSearchParams(currentSearch);
  for (const key of allParameterNames) search.delete(key);
  const set = (key: keyof typeof parameterNames, next: string | null) => {
    if (next) search.set(parameterNames[key], next);
  };
  set("projectId", state.projectId);
  set("worktreeId", state.worktreeId);
  set("commit", state.commit);
  set(
    "selectedCommits",
    state.selectedCommits.length ? state.selectedCommits.join(",") : null,
  );
  set("filePath", state.filePath);
  if (state.comparison) {
    set("compareLeft", state.comparison.left);
    set("compareRight", state.comparison.right);
    set("compareMode", state.comparison.mode);
  }
  for (const key of [
    "message",
    "author",
    "hash",
    "dateFrom",
    "dateTo",
    "path",
    "branch",
    "tag",
  ] as const) {
    set(key, state.options.filters[key]);
  }
  if (state.options.firstParent) search.set(parameterNames.firstParent, "1");
  if (state.options.hideMerges) search.set(parameterNames.hideMerges, "1");
  const serialized = search.toString();
  return serialized ? `?${serialized}` : "";
}

export function replaceGitHistoryRoute(state: GitHistoryRouteState): void {
  const url = new URL(window.location.href);
  url.search = gitHistoryRouteSearch(url.search, state);
  window.history.replaceState(window.history.state, "", url);
}

export function pushGitHistoryRoute(state: GitHistoryRouteState): void {
  const url = new URL(window.location.href);
  url.search = gitHistoryRouteSearch(url.search, state);
  window.history.pushState(window.history.state, "", url);
}

export interface OpenGitFileHistoryRequest {
  projectId: string;
  worktreeId: string;
  path: string;
}

export const openGitFileHistoryEvent = "cantrip:open-git-file-history";

export function requestGitFileHistory(detail: OpenGitFileHistoryRequest): void {
  window.dispatchEvent(
    new CustomEvent<OpenGitFileHistoryRequest>(openGitFileHistoryEvent, {
      detail,
    }),
  );
}
