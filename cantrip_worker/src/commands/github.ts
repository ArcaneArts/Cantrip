import type { WorkerCommand } from "@cantrip/protocol";
import type { GithubClient } from "../github.js";

export type GithubCommand = Extract<
  WorkerCommand,
  {
    type:
      | "github.auth.status"
      | "github.repositories.cached"
      | "github.repositories.list"
      | "github.repository-owners.list"
      | "github.repositories.create"
      | "github.issues.list"
      | "github.inbox.list"
      | "github.pull-requests.list"
      | "github.issue.get"
      | "github.issue.create"
      | "github.issue.comment"
      | "github.issue.close"
      | "github.pull-request.create"
      | "github.pull-request.get"
      | "github.pull-request.agent-context"
      | "github.pull-request.comment"
      | "github.pull-request.review.submit"
      | "github.pull-request.review.comment"
      | "github.pull-request.review.reply"
      | "github.pull-request.review.mutate"
      | "github.pull-request.lifecycle.preview"
      | "github.pull-request.lifecycle.apply"
      | "github.pull-request.checkout.prepare"
      | "github.actions.overview"
      | "github.actions.run.get"
      | "github.actions.run.logs"
      | "github.actions.workflow.dispatch"
      | "github.actions.run.action"
      | "github.actions.run.checkout.prepare"
      | "github.releases.list"
      | "github.release.get"
      | "github.release.create";
  }
>;
export interface GithubCommandDependencies {
  github: Pick<
    GithubClient,
    | "authStatus"
    | "cachedRepositories"
    | "listRepositories"
    | "listRepositoryOwners"
    | "createRepository"
    | "listIssues"
    | "listInbox"
    | "listPullRequests"
    | "getIssue"
    | "createIssue"
    | "commentOnIssue"
    | "closeIssue"
    | "createPullRequest"
    | "getPullRequestOverview"
    | "getPullRequestFiles"
    | "getPullRequestCommits"
    | "getPullRequestChecks"
    | "getPullRequest"
    | "getPullRequestAgentContext"
    | "commentOnPullRequest"
    | "submitPullRequestReview"
    | "commentOnPullRequestLine"
    | "replyToPullRequestReview"
    | "runPullRequestReviewAction"
    | "previewPullRequestLifecycle"
    | "applyPullRequestLifecycle"
    | "preparePullRequestCheckout"
    | "listActionsOverview"
    | "getActionsRun"
    | "readActionsRunLogs"
    | "dispatchActionsWorkflow"
    | "runActionsRunAction"
    | "prepareActionsRunCheckout"
    | "listReleases"
    | "getRelease"
    | "createRelease"
  >;
}

// Services are owned by the worker entry point; this handler only executes commands.
export async function handleGithubCommand(
  command: GithubCommand,
  dependencies: GithubCommandDependencies,
): Promise<unknown> {
  const { github } = dependencies;
  switch (command.type) {
    case "github.auth.status":
      return github.authStatus();
    case "github.repositories.cached":
      return github.cachedRepositories(command.login);
    case "github.repositories.list":
      return github.listRepositories();
    case "github.repository-owners.list":
      return github.listRepositoryOwners();
    case "github.repositories.create":
      return github.createRepository(command.request);
    case "github.issues.list":
      return github.listIssues(
        command.repository,
        command.state,
        command.cursor,
        command.limit,
        command.filters,
      );
    case "github.inbox.list":
      return github.listInbox(
        command.repository,
        command.kind,
        command.state,
        command.view,
        command.cursor,
        command.limit,
      );
    case "github.pull-requests.list":
      return github.listPullRequests(
        command.repository,
        command.state,
        command.cursor,
        command.limit,
        command.filters,
      );
    case "github.issue.get":
      return github.getIssue(command.repository, command.number);
    case "github.issue.create":
      return github.createIssue(command.repository, command.request);
    case "github.issue.comment":
      return github.commentOnIssue(
        command.repository,
        command.number,
        command.body,
      );
    case "github.issue.close":
      return github.closeIssue(
        command.repository,
        command.number,
        command.comment,
      );
    case "github.pull-request.create":
      return github.createPullRequest(
        command.repository,
        command.cwd,
        command.request,
      );
    case "github.pull-request.get":
      switch (command.section) {
        case "overview":
          return github.getPullRequestOverview(
            command.repository,
            command.cwd,
            command.number,
          );
        case "files":
          return github.getPullRequestFiles(
            command.repository,
            command.cwd,
            command.number,
          );
        case "commits":
          return github.getPullRequestCommits(
            command.repository,
            command.cwd,
            command.number,
          );
        case "checks":
          return github.getPullRequestChecks(
            command.repository,
            command.cwd,
            command.number,
          );
        case "all":
          return github.getPullRequest(
            command.repository,
            command.cwd,
            command.number,
          );
      }
    case "github.pull-request.agent-context":
      return github.getPullRequestAgentContext(
        command.repository,
        command.cwd,
        command.number,
        command.request,
      );
    case "github.pull-request.comment":
      return github.commentOnPullRequest(
        command.repository,
        command.cwd,
        command.number,
        command.body,
      );
    case "github.pull-request.review.submit":
      return github.submitPullRequestReview(
        command.repository,
        command.cwd,
        command.number,
        command.review,
      );
    case "github.pull-request.review.comment":
      return github.commentOnPullRequestLine(
        command.repository,
        command.cwd,
        command.number,
        command.comment,
      );
    case "github.pull-request.review.reply":
      return github.replyToPullRequestReview(
        command.repository,
        command.cwd,
        command.number,
        command.commentId,
        command.body,
      );
    case "github.pull-request.review.mutate":
      return github.runPullRequestReviewAction(
        command.repository,
        command.cwd,
        command.number,
        command.action,
      );
    case "github.pull-request.lifecycle.preview":
      return github.previewPullRequestLifecycle(
        command.repository,
        command.cwd,
        command.number,
        command.action,
      );
    case "github.pull-request.lifecycle.apply":
      return github.applyPullRequestLifecycle(
        command.repository,
        command.cwd,
        command.number,
        command.request,
      );
    case "github.pull-request.checkout.prepare":
      return github.preparePullRequestCheckout(
        command.repository,
        command.cwd,
        command.number,
      );
    case "github.actions.overview":
      return github.listActionsOverview(
        command.repository,
        command.cwd,
        command.page,
        command.limit,
      );
    case "github.actions.run.get":
      return github.getActionsRun(
        command.repository,
        command.cwd,
        command.runId,
      );
    case "github.actions.run.logs":
      return github.readActionsRunLogs(
        command.repository,
        command.cwd,
        command.runId,
        command.jobId,
      );
    case "github.actions.workflow.dispatch":
      return github.dispatchActionsWorkflow(
        command.repository,
        command.cwd,
        command.request,
      );
    case "github.actions.run.action":
      return github.runActionsRunAction(
        command.repository,
        command.cwd,
        command.request,
      );
    case "github.actions.run.checkout.prepare":
      return github.prepareActionsRunCheckout(
        command.repository,
        command.cwd,
        command.runId,
      );
    case "github.releases.list":
      return github.listReleases(command.repository);
    case "github.release.get":
      return github.getRelease(command.repository, command.releaseId);
    case "github.release.create":
      return github.createRelease(
        command.repository,
        command.cwd,
        command.request,
      );
  }
}
