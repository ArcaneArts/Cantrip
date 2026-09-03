import type {
  GithubPullRequestLifecycleAction,
  GithubPullRequestOverview,
} from "@cantrip/protocol";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ArchiveRestore,
  GitMerge,
  GitPullRequestDraft,
  ListEnd,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from "@/components/ui/styled-menu";

export function GithubPullRequestActionsMenu({
  detail,
  onEdit,
  onLifecycle,
}: {
  detail: GithubPullRequestOverview;
  onEdit(): void;
  onLifecycle(action: GithubPullRequestLifecycleAction): void;
}) {
  const open = detail.state === "open" && !detail.merged;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button
          aria-label="More pull request actions"
          size="icon"
          variant="outline"
        >
          <MoreHorizontal className="size-3.5" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <StyledDropdownMenuContent align="end" className="min-w-52">
          <StyledDropdownMenuItem onSelect={onEdit}>
            <Pencil className="size-3.5" /> Edit details
          </StyledDropdownMenuItem>
          {open ? (
            <StyledDropdownMenuItem
              onSelect={() => onLifecycle({ type: "update-branch" })}
            >
              <RefreshCw className="size-3.5" /> Update branch
            </StyledDropdownMenuItem>
          ) : null}
          {open && detail.draft ? (
            <StyledDropdownMenuItem
              onSelect={() => onLifecycle({ type: "mark-ready" })}
            >
              <ShieldCheck className="size-3.5" /> Mark ready
            </StyledDropdownMenuItem>
          ) : null}
          {open && !detail.draft ? (
            <StyledDropdownMenuItem
              onSelect={() => onLifecycle({ type: "convert-draft" })}
            >
              <GitPullRequestDraft className="size-3.5" /> Convert to draft
            </StyledDropdownMenuItem>
          ) : null}
          {open && !detail.draft && !detail.autoMerge ? (
            <StyledDropdownMenuItem
              onSelect={() =>
                onLifecycle({
                  type: "enable-auto-merge",
                  method: "squash",
                  commitTitle: null,
                  commitMessage: null,
                })
              }
            >
              <GitMerge className="size-3.5" /> Enable auto-merge
            </StyledDropdownMenuItem>
          ) : null}
          {open && detail.autoMerge ? (
            <StyledDropdownMenuItem
              onSelect={() => onLifecycle({ type: "disable-auto-merge" })}
            >
              <XCircle className="size-3.5" /> Disable auto-merge
            </StyledDropdownMenuItem>
          ) : null}
          {open &&
          !detail.draft &&
          detail.mergeQueueEnabled &&
          !detail.mergeQueueEntry ? (
            <StyledDropdownMenuItem
              onSelect={() => onLifecycle({ type: "enqueue-merge-queue" })}
            >
              <ListEnd className="size-3.5" /> Enter merge queue
            </StyledDropdownMenuItem>
          ) : null}
          {open && detail.mergeQueueEntry ? (
            <StyledDropdownMenuItem
              onSelect={() => onLifecycle({ type: "dequeue-merge-queue" })}
            >
              <ArchiveRestore className="size-3.5" /> Leave merge queue
            </StyledDropdownMenuItem>
          ) : null}
          {open ? (
            <StyledDropdownMenuItem
              className="text-destructive"
              onSelect={() => onLifecycle({ type: "close" })}
            >
              <XCircle className="size-3.5" /> Close pull request
            </StyledDropdownMenuItem>
          ) : null}
          {detail.state === "closed" && !detail.merged ? (
            <StyledDropdownMenuItem
              onSelect={() => onLifecycle({ type: "reopen" })}
            >
              <ArchiveRestore className="size-3.5" /> Reopen pull request
            </StyledDropdownMenuItem>
          ) : null}
        </StyledDropdownMenuContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
