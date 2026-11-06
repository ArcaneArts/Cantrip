import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import type {
  CantripOsInstanceSummary,
  CantripOsWorkspaceSummary,
} from "@cantrip/protocol";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/error-message";
import { onClientSessionIdentityChanged } from "@/lib/client-session";
import {
  cantripOsDesktopAccountKey,
  readCantripOsDesktopDraft,
  prepareCantripOsDesktopDraft,
  saveCantripOsDesktopDraft,
  clearCantripOsDesktopDraft,
  type CantripOsDesktopDraft,
} from "@/lib/cantrip-os-desktop-draft";
import {
  getCantripOsDesktop,
  getCantripOsDesktopOperations,
  submitCantripOsDesktop,
  observeCantripOsDesktopDraft,
  observeCantripOsDesktopOperation,
  type CantripOsDesktopSummary,
} from "@/lib/api/cantrip-os-desktop";

const labels = { start: "Start", stop: "Stop", restart: "Restart" };
type Selection = {
  action: keyof typeof labels;
  target: CantripOsDesktopDraft["target"];
  accountKey: string;
  identityEpoch: number;
};
type DraftState = {
  draft: CantripOsDesktopDraft | null;
  accountKey: string | null;
  error?: string;
};
const states = {
  admitted: "Admitted",
  running: "In progress",
  ready: "Completed",
  failed: "Failed",
  unknown: "Outcome unknown",
};

export function CantripOsDesktopControls({
  instance,
  workspace,
  onChanged,
}: {
  instance: CantripOsInstanceSummary;
  workspace: CantripOsWorkspaceSummary;
  onChanged(): void;
}) {
  function readState(): DraftState {
    let accountKey: string | null = null;
    try {
      accountKey = cantripOsDesktopAccountKey();
      return {
        accountKey,
        draft: readCantripOsDesktopDraft(instance.id, workspace.id),
      };
    } catch (error) {
      return { accountKey, draft: null, error: errorMessage(error) };
    }
  }
  const [saved, setSaved] = useState(readState);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [result, setResult] = useState<CantripOsDesktopSummary | null>(null);
  const active = useRef<object | null>(null);
  const identityEpoch = useRef(0);
  const desktop = useQuery({
    queryKey: [
      "cantrip-os-desktop",
      saved.accountKey,
      instance.id,
      instance.attachmentGeneration,
      instance.runtimeGeneration,
      workspace.id,
    ],
    queryFn: () => getCantripOsDesktop(instance, workspace, saved.accountKey!),
    retry: false,
    enabled: Boolean(saved.accountKey),
  });
  const history = useInfiniteQuery({
    queryKey: [
      "cantrip-os-desktop-operations",
      saved.accountKey,
      instance.id,
      workspace.id,
    ],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      getCantripOsDesktopOperations(
        instance.id,
        workspace.id,
        pageParam,
        saved.accountKey!,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    retry: false,
    enabled: Boolean(saved.accountKey),
  });
  function retain(draft: CantripOsDesktopDraft) {
    saveCantripOsDesktopDraft(draft);
    setSaved({ accountKey: draft.accountKey, draft });
  }
  function dismiss() {
    try {
      if (!saved.accountKey)
        throw new Error("An authenticated session is required.");
      clearCantripOsDesktopDraft(instance.id, workspace.id, saved.accountKey);
      setSaved({ accountKey: saved.accountKey, draft: null });
    } catch (error) {
      setSaved({ ...saved, error: errorMessage(error) });
    }
  }
  const changed = () => {
    void desktop.refetch();
    void history.refetch();
    onChanged();
  };
  const mutate = useMutation({
    retry: false,
    mutationFn: async (run: () => Promise<CantripOsDesktopSummary>) => {
      if (active.current)
        throw new Error("A desktop action is already in progress.");
      const epoch = identityEpoch.current,
        accountKey = cantripOsDesktopAccountKey();
      const token = {};
      active.current = token;
      try {
        return { value: await run(), epoch, accountKey };
      } finally {
        if (active.current === token) active.current = null;
      }
    },
    onSuccess: ({ value, epoch, accountKey }) => {
      if (
        epoch !== identityEpoch.current ||
        accountKey !== cantripOsDesktopAccountKey()
      )
        return;
      setResult(value);
      try {
        const draft = readCantripOsDesktopDraft(instance.id, workspace.id);
        if (
          draft?.request.operationId === value.operationId &&
          ["ready", "failed"].includes(value.state)
        ) {
          clearCantripOsDesktopDraft(
            instance.id,
            workspace.id,
            draft.accountKey,
          );
          setSaved({ accountKey: draft.accountKey, draft: null });
        }
      } catch {
        setSaved(readState());
      }
    },
    onSettled: changed,
  });
  useEffect(
    () =>
      onClientSessionIdentityChanged(() => {
        identityEpoch.current++;
        active.current = null;
        mutate.reset();
        setSaved(readState());
        setSelection(null);
        setResult(null);
      }),
    [instance.id, workspace.id],
  );
  async function send(draft: CantripOsDesktopDraft) {
    if (draft.submitted)
      throw new Error(
        "This request was already sent. Observe its original admission.",
      );
    const submitted = { ...draft, submitted: true };
    retain(submitted); // Retain the exact request before the first HTTP send.
    return submitCantripOsDesktop(submitted);
  }
  const entries = history.data?.pages.flatMap((page) => page.items) ?? [];
  const pending = entries.some(
    (entry) =>
      entry.attachmentGeneration === instance.attachmentGeneration &&
      entry.runtimeGeneration === instance.runtimeGeneration &&
      entry.workspaceId === workspace.id &&
      entry.targetGeneration === desktop.data?.target?.generation &&
      ["admitted", "running", "unknown"].includes(entry.state),
  );
  const error =
    saved.error ??
    (mutate.error && errorMessage(mutate.error)) ??
    (desktop.error && errorMessage(desktop.error)) ??
    (history.error && errorMessage(history.error));
  return (
    <section
      className="space-y-3 rounded-lg border p-4"
      aria-label="Workspace desktop"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium">Workspace desktop</h3>
        <Button variant="ghost" size="sm" onClick={changed}>
          Refresh desktop
        </Button>
      </div>
      <p className="text-sm text-muted-foreground" role="status">
        Desktop · {workspace.guestWorkspaceId}:{" "}
        {desktop.isFetching
          ? "Checking"
          : desktop.isError
            ? "Unverified"
            : desktop.data?.observation
              ? desktop.data.observation.status === "running"
                ? "Running"
                : "Stopped"
              : "Unverified"}
        {" · "}Linux: {instance.status}
      </p>
      {desktop.data?.error ? (
        <p className="text-sm text-muted-foreground">{desktop.data.error}</p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {desktop.data?.target ? (
        <div className="flex flex-wrap gap-2">
          {Object.entries(labels).map(([action, label]) => (
            <Button
              key={action}
              variant="ghost"
              size="sm"
              disabled={
                mutate.isPending ||
                Boolean(saved.draft) ||
                Boolean(saved.error) ||
                pending
              }
              onClick={() =>
                setSelection({
                  action: action as Selection["action"],
                  target: structuredClone(desktop.data!.target!),
                  accountKey: saved.accountKey!,
                  identityEpoch: identityEpoch.current,
                })
              }
            >
              {label} desktop
            </Button>
          ))}
        </div>
      ) : null}
      {pending ? (
        <p className="text-sm text-muted-foreground">
          An operation on this target remains unresolved. Observe its history
          before starting another.
        </p>
      ) : null}
      {selection ? (
        <div className="space-y-2 text-sm">
          <p>
            {labels[selection.action]} desktop for {workspace.guestWorkspaceId}{" "}
            on {instance.name}?
          </p>
          <p className="text-muted-foreground">
            Stop and restart close this workspace’s graphical applications.
            Files and independent terminal/Run processes remain. Other workspace
            desktops stay separate.
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={mutate.isPending}
              onClick={() => {
                const chosen = selection;
                setSelection(null);
                mutate.mutate(async () => {
                  if (
                    chosen.accountKey !== cantripOsDesktopAccountKey() ||
                    chosen.identityEpoch !== identityEpoch.current
                  )
                    throw new Error(
                      "The account or server changed. Select the intended desktop action again.",
                    );
                  if (readCantripOsDesktopDraft(instance.id, workspace.id))
                    throw new Error(
                      "Observe or dismiss the saved request first.",
                    );
                  const draft = prepareCantripOsDesktopDraft(
                    chosen.target,
                    chosen.action,
                  );
                  retain(draft);
                  return send(draft);
                });
              }}
            >
              Confirm {selection.action}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelection(null)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {saved.draft ? (
        <div className="space-y-2 text-sm">
          <p>
            Saved {saved.draft.request.action} request:{" "}
            {saved.draft.submitted
              ? "observe its original outcome before starting another operation."
              : "not sent yet."}
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={mutate.isPending}
              onClick={() =>
                mutate.mutate(() =>
                  saved.draft!.submitted
                    ? observeCantripOsDesktopDraft(saved.draft!)
                    : send(saved.draft!),
                )
              }
            >
              {saved.draft.submitted
                ? "Observe saved request"
                : "Submit saved request"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={mutate.isPending}
              onClick={dismiss}
            >
              Dismiss saved request
            </Button>
          </div>
          <p className="text-muted-foreground">
            Dismissing this reminder does not cancel an admitted operation. Its
            history remains below.
          </p>
        </div>
      ) : saved.error && saved.accountKey ? (
        <Button variant="ghost" size="sm" onClick={dismiss}>
          Dismiss unreadable saved request
        </Button>
      ) : null}
      {result ? (
        <p role="status" className="text-sm">
          {labels[result.action]}: {states[result.state]}.
          {result.error ? ` ${result.error}` : ""}
          {result.state === "ready" && result.action !== "stop"
            ? " Open the intended source’s desktop again to obtain fresh viewing and computer-use authority."
            : ""}
        </p>
      ) : null}
      <div className="space-y-2">
        <h4 className="text-sm font-medium">Desktop history</h4>
        {entries.map((entry) => (
          <article key={entry.operationId} className="space-y-1 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span>
                {labels[entry.action]} · {states[entry.state]}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={mutate.isPending}
                onClick={() =>
                  mutate.mutate(() =>
                    observeCantripOsDesktopOperation(entry, saved.accountKey!),
                  )
                }
              >
                Observe operation
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {new Date(entry.createdAt).toLocaleString()}
              {entry.completionEvidence === "observed-state"
                ? " · Requested state observed"
                : entry.completionEvidence
                  ? " · Acknowledged and observed"
                  : ""}
            </p>
            {entry.error ? (
              <p className="text-xs text-muted-foreground">{entry.error}</p>
            ) : null}
          </article>
        ))}
        {!entries.length && history.isSuccess ? (
          <p className="text-sm text-muted-foreground">
            No recorded desktop operations.
          </p>
        ) : null}
        {history.hasNextPage ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={history.isFetchingNextPage}
            onClick={() => void history.fetchNextPage()}
          >
            Older desktop operations
          </Button>
        ) : null}
      </div>
    </section>
  );
}
