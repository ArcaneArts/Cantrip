import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import type { CantripOsInstanceSummary } from "@cantrip/protocol";
import {
  onClientSessionIdentityChanged,
  getClientSessionIdentitySnapshot,
} from "@/lib/client-session";
import { errorMessage } from "@/lib/error-message";
import {
  cantripOsSystemAccountKey,
  readCantripOsSystemDraft,
  saveCantripOsSystemDraft,
  prepareCantripOsSystemDraft,
  assertCantripOsSystemDraftCurrent,
  clearCantripOsSystemDraft,
  type CantripOsSystemDraft,
  type CantripOsSystemIntent,
  type CantripOsSystemDestination,
  type CantripOsSystemSummary,
} from "@/lib/cantrip-os-system-draft";
import {
  getCantripOsSystem,
  getCantripOsSystemOperations,
  authorizeCantripOsSystemWorker,
  submitCantripOsSystem,
  observeCantripOsSystemDraft,
  observeCantripOsSystemOperation,
} from "@/lib/api/cantrip-os-systems";

type Saved = {
  account: string | null;
  instanceId: string;
  draft: CantripOsSystemDraft | null;
  error?: string;
};
export type CantripOsSystemAction =
  | { kind: "operation"; value: CantripOsSystemSummary }
  | { kind: "recovery"; value: CantripOsInstanceSummary };
const terminal = (value: CantripOsSystemSummary) =>
  ["ready", "failed", "rejected"].includes(value.state);
export function useCantripOsSystems(
  instance: CantripOsInstanceSummary,
  onChanged: () => void,
) {
  const read = (): Saved => {
    let account: string | null = null;
    try {
      account = cantripOsSystemAccountKey();
      return {
        account,
        instanceId: instance.id,
        draft: readCantripOsSystemDraft(instance.id),
      };
    } catch (error) {
      return {
        account,
        instanceId: instance.id,
        draft: null,
        error: errorMessage(error),
      };
    }
  };
  const [saved, setSaved] = useState(read),
    [review, setReview] = useState<{
      draft: CantripOsSystemDraft;
      epoch: number;
    } | null>(null);
  const [known, setKnown] = useState<Record<string, CantripOsSystemSummary>>(
      {},
    ),
    [recovered, setRecovered] = useState(false);
  const active = useRef<object | null>(null),
    epoch = useRef(0),
    observedUnknown = useRef(new Set<string>());
  let account: string | null = null;
  try {
    account = cantripOsSystemAccountKey();
  } catch {
    /* Represented by the disabled controls. */
  }
  const current = Boolean(
    saved.account &&
    account === saved.account &&
    saved.instanceId === instance.id &&
    instance.ownerId === getClientSessionIdentitySnapshot()?.userId,
  );
  const status = useQuery({
    queryKey: [
      "cantrip-os-system",
      saved.account,
      instance.id,
      instance.attachmentGeneration,
    ],
    queryFn: () => getCantripOsSystem(instance, saved.account!),
    enabled: current,
    retry: false,
  });
  const history = useInfiniteQuery({
    queryKey: ["cantrip-os-system-operations", saved.account, instance.id],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      getCantripOsSystemOperations(instance.id, pageParam, saved.account!),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: current,
    retry: false,
  });
  function changed() {
    void status.refetch();
    void history.refetch();
    onChanged();
  }
  const mutation = useMutation({
    retry: false,
    mutationFn: async (run: () => Promise<CantripOsSystemAction>) => {
      if (active.current)
        throw new Error("A system action is already in progress.");
      const selectedEpoch = epoch.current,
        selectedAccount = cantripOsSystemAccountKey(),
        token = {};
      active.current = token;
      try {
        return {
          result: await run(),
          epoch: selectedEpoch,
          account: selectedAccount,
        };
      } finally {
        if (active.current === token) active.current = null;
      }
    },
    onSuccess: ({ result, epoch: returnedEpoch, account: returnedAccount }) => {
      if (returnedEpoch !== epoch.current) return;
      try {
        if (cantripOsSystemAccountKey() !== returnedAccount) return;
      } catch {
        return;
      }
      if (result.kind === "recovery") {
        setRecovered(true);
        return;
      }
      const value = result.value;
      setKnown((previous) => ({ ...previous, [value.operationId]: value }));
      try {
        const pending = readCantripOsSystemDraft(instance.id);
        if (
          pending?.request.operationId === value.operationId &&
          terminal(value)
        ) {
          clearCantripOsSystemDraft(instance.id, pending.accountKey);
          setSaved({
            account: pending.accountKey,
            instanceId: instance.id,
            draft: null,
          });
        }
      } catch {
        setSaved(read());
      }
    },
    onSettled: changed,
  });
  useEffect(() => {
    const unsubscribe = onClientSessionIdentityChanged(() => {
      epoch.current++;
      active.current = null;
      observedUnknown.current.clear();
      mutation.reset();
      setSaved(read());
      setReview(null);
      setKnown({});
      setRecovered(false);
    });
    return () => {
      epoch.current++;
      active.current = null;
      unsubscribe();
    };
  }, [instance.id]);
  useEffect(() => {
    mutation.reset();
    setKnown({});
    setRecovered(false);
  }, [instance.id]);
  useEffect(() => {
    epoch.current++;
    setReview(null);
    setSaved(read());
  }, [instance.id, instance.attachmentGeneration]);
  const records = new Map<string, CantripOsSystemSummary>();
  if (current) {
    for (const entry of history.data?.pages.flatMap((page) => page.items) ?? [])
      records.set(entry.operationId, entry);
    for (const entry of Object.values(known)) {
      if (
        entry.instanceId !== instance.id ||
        entry.workerId !== instance.workerId
      )
        continue;
      const existing = records.get(entry.operationId);
      const latest =
        !existing ||
        existing.updatedAt < entry.updatedAt ||
        (!terminal(existing) && terminal(entry))
          ? entry
          : existing;
      records.set(entry.operationId, {
        ...latest,
        retiredBy: existing?.retiredBy ?? entry.retiredBy,
        recoveryGeneration:
          existing?.recoveryGeneration ?? entry.recoveryGeneration,
      });
    }
  }
  const entries = [...records.values()].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  function runOperation(run: () => Promise<CantripOsSystemSummary>) {
    mutation.mutate(async () => ({ kind: "operation", value: await run() }));
  }
  useEffect(() => {
    const entry = entries.find(
      (item) =>
        !item.retiredBy &&
        item.attachmentGeneration === instance.attachmentGeneration &&
        !terminal(item) &&
        (item.state !== "unknown" ||
          !observedUnknown.current.has(item.operationId)),
    );
    if (!entry || !current || !saved.account || mutation.isPending) return;
    const selectedAccount = saved.account;
    const timer = setTimeout(() => {
      if (entry.state === "unknown")
        observedUnknown.current.add(entry.operationId);
      runOperation(() =>
        observeCantripOsSystemOperation(entry, selectedAccount),
      );
    }, 2500);
    return () => clearTimeout(timer);
  }, [
    entries,
    instance.attachmentGeneration,
    current,
    saved.account,
    mutation.isPending,
  ]);
  function retain(draft: CantripOsSystemDraft) {
    saveCantripOsSystemDraft(draft);
    setSaved({
      account: draft.accountKey,
      instanceId: draft.destination.instanceId,
      draft,
    });
  }
  async function send(input: CantripOsSystemDraft) {
    const draft = assertCantripOsSystemDraftCurrent(input);
    await authorizeCantripOsSystemWorker(
      draft.destination.workerId,
      draft.accountKey,
    );
    assertCantripOsSystemDraftCurrent(draft);
    const submitted = { ...draft, submitted: true };
    retain(submitted);
    return submitCantripOsSystem(submitted);
  }
  function choose(
    destination: CantripOsSystemDestination,
    intent: CantripOsSystemIntent,
  ) {
    setReview({
      draft: prepareCantripOsSystemDraft(destination, intent),
      epoch: epoch.current,
    });
    setRecovered(false);
  }
  function confirm() {
    const selected = review;
    if (!selected) return;
    setReview(null);
    runOperation(async () => {
      if (selected.epoch !== epoch.current)
        throw new Error(
          "The destination changed. Review the intended system action again.",
        );
      const draft = assertCantripOsSystemDraftCurrent(selected.draft);
      const pending = readCantripOsSystemDraft(instance.id);
      const replacesPending =
        draft.request.action === "rollback" &&
        pending?.request.operationId === draft.request.replacementOperationId;
      if (pending && !replacesPending)
        throw new Error("Check or dismiss the saved system request first.");
      retain(draft);
      return send(draft);
    });
  }
  function dismiss() {
    try {
      if (!saved.account)
        throw new Error("An authenticated session is required.");
      clearCantripOsSystemDraft(instance.id, saved.account);
      setSaved({
        account: saved.account,
        instanceId: instance.id,
        draft: null,
      });
    } catch (error) {
      setSaved({ ...saved, error: errorMessage(error) });
    }
  }
  return {
    account: current ? saved.account : null,
    saved: current
      ? saved
      : { account: null, instanceId: instance.id, draft: null },
    review:
      current && review?.draft.destination.instanceId === instance.id
        ? review
        : null,
    choose,
    confirm,
    cancelReview: () => setReview(null),
    dismiss,
    runOperation,
    runRecovery: (run: () => Promise<CantripOsInstanceSummary>) =>
      mutation.mutate(async () => ({ kind: "recovery", value: await run() })),
    checkSaved: () =>
      saved.draft &&
      runOperation(() =>
        saved.draft!.submitted
          ? observeCantripOsSystemDraft(saved.draft!)
          : send(saved.draft!),
      ),
    resubmitSaved: () => saved.draft && runOperation(() => send(saved.draft!)),
    pending: mutation.isPending,
    status: current ? status.data : undefined,
    history,
    entries,
    changed,
    recovered: current && recovered,
    failure: !current
      ? null
      : (saved.error ??
        (mutation.error || status.error || history.error
          ? errorMessage(mutation.error ?? status.error ?? history.error)
          : null)),
  };
}
