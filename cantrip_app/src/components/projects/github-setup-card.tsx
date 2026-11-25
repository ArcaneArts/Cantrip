import type { GithubToolsStatus } from "@cantrip/protocol";
import { Download, GitBranch, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { errorMessage } from "@/lib/error-message";

export function githubToolsMissing(tools?: GithubToolsStatus) {
  return (
    tools !== undefined && (!tools.gitInstalled || !tools.githubCliInstalled)
  );
}

export function GithubSetupCard({
  tools,
  workerName,
  installing,
  awaitingInstaller,
  checking,
  error,
  onSetup,
  onCheck,
}: {
  tools?: GithubToolsStatus;
  workerName?: string;
  installing: boolean;
  awaitingInstaller: boolean;
  checking: boolean;
  error: Error | null;
  onSetup(): void;
  onCheck(): void;
}) {
  const missing = githubToolsMissing(tools);
  const automatic =
    missing && (tools?.platform === "macos" || tools?.platform === "windows");
  const worker = workerName || "the selected worker";
  const missingLabel =
    !tools?.gitInstalled && !tools?.githubCliInstalled
      ? "Git and GitHub CLI"
      : !tools?.gitInstalled
        ? "Git"
        : "GitHub CLI";

  return (
    <Card>
      <CardHeader>
        <div className="mb-2 grid size-10 place-items-center rounded-lg border">
          <GitBranch className="size-5" />
        </div>
        <CardTitle>
          {missing
            ? `Install ${missingLabel}`
            : "Sign in to GitHub on the worker"}
        </CardTitle>
        <CardDescription className="max-w-xl leading-6">
          {missing ? (
            automatic ? (
              <>
                Cantrip will set up {missingLabel} on {worker}.{" "}
                {tools?.platform === "macos" && !tools.gitInstalled
                  ? "Confirm the Command Line Tools installer on that Mac."
                  : null}
              </>
            ) : (
              <>
                Install {missingLabel} on {worker}, then check again.
              </>
            )
          ) : (
            <>
              Run{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 break-words">
                {tools?.signInCommand ?? "gh auth login"}
              </code>{" "}
              in a terminal on {worker}. Complete GitHub sign-in, then check
              again.
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {awaitingInstaller ? (
          <p role="status" className="text-sm text-muted-foreground">
            Finish installing Command Line Tools on the worker. Cantrip will
            check for Git automatically.
          </p>
        ) : null}
        {error && missing ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(error)}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {automatic ? (
            <Button onClick={onSetup} disabled={installing}>
              {installing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Download className="size-4" />
              )}
              {installing ? "Setting up…" : "Setup for me"}
            </Button>
          ) : null}
          <Button
            variant={automatic ? "outline" : "default"}
            onClick={onCheck}
            disabled={installing || checking}
          >
            <RefreshCw
              className={checking ? "size-4 animate-spin" : "size-4"}
            />
            Check again
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
