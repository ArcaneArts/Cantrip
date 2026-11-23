import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { CantripOsInstanceSummary } from "@cantrip/protocol";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/error-message";
import { onClientSessionIdentityChanged } from "@/lib/client-session";
import {
  cantripOsWorkspaceCreateAccountKey,
  prepareCantripOsWorkspaceCreateDraft,
  readCantripOsWorkspaceCreateDraft,
  saveCantripOsWorkspaceCreateDraft,
  clearCantripOsWorkspaceCreateDraft,
  type CantripOsWorkspaceCreateDraft,
} from "@/lib/cantrip-os-workspace-create-draft";
import {
  getCantripOsWorkspaceOperations,
  submitCantripOsWorkspaceCreate,
  observeCantripOsWorkspaceCreateDraft,
  observeCantripOsWorkspaceOperation,
  type CantripOsWorkspaceOperationSummary,
} from "@/lib/api/cantrip-os-workspace-operations";

type Saved = {
  accountKey: string | null;
  draft: CantripOsWorkspaceCreateDraft | null;
  error?: string;
};
const states = {
  admitted: "Admitted",
  running: "In progress",
  ready: "Completed",
  failed: "Failed",
  unknown: "Outcome unknown",
};
export function CantripOsWorkspaceCreateControls({
  instance,
  onChanged,
}: {
  instance: CantripOsInstanceSummary;
  onChanged(): void;
}) {
  function read(): Saved {
    let accountKey: string | null = null;
    try {
      accountKey = cantripOsWorkspaceCreateAccountKey();
      return {
        accountKey,
        draft: readCantripOsWorkspaceCreateDraft(instance.id),
      };
    } catch (error) {
      return { accountKey, draft: null, error: errorMessage(error) };
    }
  }
  const [saved, setSaved] = useState(read),
    [name, setName] = useState("work");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [result, setResult] =
    useState<CantripOsWorkspaceOperationSummary | null>(null);
  const active = useRef<object | null>(null),
    epoch = useRef(0);
  const history = useInfiniteQuery({
    queryKey: [
      "cantrip-os-workspace-operations",
      saved.accountKey,
      instance.id,
    ],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      getCantripOsWorkspaceOperations(
        instance.id,
        pageParam,
        saved.accountKey!,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    retry: false,
    enabled: Boolean(saved.accountKey),
  });
  useEffect(
    () =>
      onClientSessionIdentityChanged(() => {
        epoch.current++;
        active.current = null;
        setBusy(false);
        setError(null);
        setResult(null);
        setSaved(read());
      }),
    [instance.id],
  );
  async function run(
    operation: () => Promise<CantripOsWorkspaceOperationSummary>,
  ) {
    if (active.current) return;
    let accountKey: string;
    try {
      accountKey = cantripOsWorkspaceCreateAccountKey();
    } catch (failure) {
      setError(errorMessage(failure));
      return;
    }
    const currentEpoch = epoch.current,
      token = {};
    active.current = token;
    setBusy(true);
    setError(null);
    const current = () => {
      try {
        return (
          currentEpoch === epoch.current &&
          accountKey === cantripOsWorkspaceCreateAccountKey()
        );
      } catch {
        return false;
      }
    };
    try {
      const value = await operation();
      if (!current()) return;
      setResult(value);
      const draft = readCantripOsWorkspaceCreateDraft(instance.id);
      if (
        draft?.request.operationId === value.operationId &&
        ["ready", "failed"].includes(value.state)
      ) {
        clearCantripOsWorkspaceCreateDraft(instance.id, accountKey);
        setSaved({ accountKey, draft: null });
        if (value.state === "ready") setName("");
      }
      void history.refetch();
      onChanged();
    } catch (failure) {
      if (current()) setError(errorMessage(failure));
    } finally {
      if (active.current === token) {
        active.current = null;
        setBusy(false);
      }
    }
  }
  function retain(draft: CantripOsWorkspaceCreateDraft) {
    saveCantripOsWorkspaceCreateDraft(draft);
    setSaved({ accountKey: draft.accountKey, draft });
  }
  function send(draft: CantripOsWorkspaceCreateDraft) {
    if (draft.submitted)
      throw new Error(
        "Observe the saved request instead of sending creation again.",
      );
    const submitted = { ...draft, submitted: true };
    retain(submitted);
    return submitCantripOsWorkspaceCreate(submitted);
  }
  function dismiss() {
    try {
      if (!saved.accountKey)
        throw new Error("An authenticated session is required.");
      clearCantripOsWorkspaceCreateDraft(instance.id, saved.accountKey);
      setSaved({ accountKey: saved.accountKey, draft: null });
      setError(null);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }
  const entries = history.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <section className="space-y-3" aria-label="Workspace creation">
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            if (readCantripOsWorkspaceCreateDraft(instance.id))
              throw new Error("Observe or dismiss the saved request first.");
            const draft = prepareCantripOsWorkspaceCreateDraft(instance, name);
            retain(draft);
            return send(draft);
          });
        }}
      >
        <label className="min-w-0 flex-1 space-y-1 text-sm">
          New workspace ID
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={24}
            required
            pattern="[a-z][a-z0-9-]{0,23}"
          />
        </label>
        <Button
          type="submit"
          disabled={
            busy ||
            Boolean(saved.draft) ||
            Boolean(saved.error) ||
            !saved.accountKey
          }
        >
          Create workspace
        </Button>
      </form>
      {saved.error || error || history.error ? (
        <p role="alert" className="text-sm text-destructive">
          {saved.error ?? error ?? errorMessage(history.error)}
        </p>
      ) : null}
      {saved.draft ? (
        <div className="space-y-2 text-sm">
          <p>
            Saved creation request for {saved.draft.request.guestWorkspaceId}:{" "}
            {saved.draft.submitted
              ? "observe its original outcome before creating again."
              : "not sent yet."}
          </p>
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(() =>
                saved.draft!.submitted
                  ? observeCantripOsWorkspaceCreateDraft(saved.draft!)
                  : send(saved.draft!),
              )
            }
          >
            {saved.draft.submitted
              ? "Observe saved request"
              : "Submit saved request"}
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={dismiss}>
            Dismiss saved request
          </Button>
          <p className="text-muted-foreground">
            Dismissing this request leaves the workspace and operation history
            intact.
          </p>
        </div>
      ) : saved.error && saved.accountKey ? (
        <Button variant="ghost" size="sm" onClick={dismiss}>
          Dismiss saved request
        </Button>
      ) : null}
      {result ? (
        <p role="status" className="text-sm">
          {result.guestWorkspaceId}: {states[result.state]}
          {result.result?.error ? ` · ${result.result.error}` : ""}
        </p>
      ) : null}
      <details>
        <summary className="cursor-pointer text-sm">
          Workspace creation history
        </summary>
        <div className="space-y-2 pt-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || history.isFetching}
            onClick={() => void history.refetch()}
          >
            Refresh creation history
          </Button>
          {entries.map((entry) => (
            <div
              key={entry.operationId}
              className="flex items-center justify-between gap-2 text-sm"
            >
              <span>
                {entry.guestWorkspaceId} · {states[entry.state]} ·{" "}
                {new Date(entry.createdAt).toLocaleString()}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    observeCantripOsWorkspaceOperation(
                      entry,
                      saved.accountKey!,
                    ),
                  )
                }
              >
                Observe creation
              </Button>
            </div>
          ))}
          {history.hasNextPage ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={history.isFetchingNextPage}
              onClick={() => void history.fetchNextPage()}
            >
              Load older creations
            </Button>
          ) : null}
        </div>
      </details>
    </section>
  );
}
