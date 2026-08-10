import type { GitAgentDraftResult, GitAgentDraftTask } from "@cantrip/protocol";
import { Check, Clipboard, Loader2, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function gitAgentTaskLabel(task: GitAgentDraftTask): string {
  return {
    "summarize-changes": "Summarize changes",
    "draft-commit-message": "Draft commit message",
    "draft-pr-description": "Draft pull request description",
    "review-commit-range": "Review commit range",
    "explain-conflicts": "Explain conflicts",
    "summarize-failed-checks": "Summarize failed checks",
  }[task];
}

export function GitAgentDraftDialog({
  draft,
  error,
  loading,
  onApply,
  onOpenChange,
  onRegenerate,
  open,
  task,
}: {
  draft: GitAgentDraftResult | null;
  error: string | null;
  loading: boolean;
  onApply?(text: string): void;
  onOpenChange(open: boolean): void;
  onRegenerate(): void;
  open: boolean;
  task: GitAgentDraftTask;
}) {
  const [text, setText] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setText(draft?.text ?? "");
    setCopied(false);
  }, [draft]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4" />
            {gitAgentTaskLabel(task)}
          </DialogTitle>
          <DialogDescription>
            Codex reads a bounded repository snapshot on this worktree. Review
            and edit the result; generating a draft never changes Git or
            publishes content.
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="flex min-h-44 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Reading changes and generating a preview…
          </div>
        ) : error ? (
          <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {error}
          </p>
        ) : (
          <textarea
            aria-label="Generated Git draft"
            className="min-h-64 w-full resize-y rounded-md border bg-background px-3 py-2 font-mono text-xs leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        )}
        {draft ? (
          <p className="text-[10px] text-muted-foreground">
            {draft.providerName} · {draft.modelName} · generated{" "}
            {new Date(draft.generatedAt).toLocaleString()}
          </p>
        ) : null}
        <DialogFooter className="flex-wrap">
          <Button
            type="button"
            variant="outline"
            disabled={loading}
            onClick={onRegenerate}
          >
            <Sparkles className="size-4" />
            {draft ? "Regenerate" : "Try again"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!text.trim()}
            onClick={() => {
              void navigator.clipboard.writeText(text).then(() => {
                setCopied(true);
              });
            }}
          >
            {copied ? (
              <Check className="size-4" />
            ) : (
              <Clipboard className="size-4" />
            )}
            {copied ? "Copied" : "Copy"}
          </Button>
          {onApply ? (
            <Button
              type="button"
              disabled={loading || !text.trim()}
              onClick={() => {
                onApply(text.trim());
                onOpenChange(false);
              }}
            >
              Use reviewed draft
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
