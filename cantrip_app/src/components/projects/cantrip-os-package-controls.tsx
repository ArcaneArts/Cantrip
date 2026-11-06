import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import {
  cantripOsPackageNameSchema,
  type CantripOsInstanceSummary,
  type CantripOsPackageCreate,
  type CantripOsPackageSummary,
} from "@cantrip/protocol";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { errorMessage } from "@/lib/error-message";
import { onClientSessionIdentityChanged } from "@/lib/client-session";
import {
  cantripOsPackageAccountKey,
  readCantripOsPackageDraft,
  prepareCantripOsPackageDraft,
  saveCantripOsPackageDraft,
  clearCantripOsPackageDraft,
  assertCantripOsPackageDraftCurrent,
  type CantripOsPackageDraft,
} from "@/lib/cantrip-os-package-draft";
import {
  getCantripOsPackages,
  getCantripOsPackageOperations,
  authorizeCantripOsPackageWorker,
  submitCantripOsPackage,
  observeCantripOsPackageDraft,
  observeCantripOsPackageOperation,
} from "@/lib/api/cantrip-os-packages";
import { CantripOsPackageEntry } from "./cantrip-os-package-entry";

type Intent = Pick<
  CantripOsPackageCreate,
  "action" | "configuration" | "packages"
>;
type Review = {
  target: CantripOsPackageDraft["target"];
  intent: Intent;
  accountKey: string;
  epoch: number;
};
type Saved = {
  draft: CantripOsPackageDraft | null;
  accountKey: string | null;
  error?: string;
};
export function CantripOsPackageControls({
  instance,
  onChanged,
}: {
  instance: CantripOsInstanceSummary;
  onChanged(): void;
}) {
  function readState(): Saved {
    let accountKey: string | null = null;
    try {
      accountKey = cantripOsPackageAccountKey();
      return { accountKey, draft: readCantripOsPackageDraft(instance.id) };
    } catch (error) {
      return { accountKey, draft: null, error: errorMessage(error) };
    }
  }
  const [saved, setSaved] = useState(readState),
    [review, setReview] = useState<Review | null>(null);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [action, setAction] = useState<Intent["action"]>("upgrade"),
    [defaults, setDefaults] = useState(false);
  const [result, setResult] = useState<CantripOsPackageSummary | null>(null);
  const active = useRef<object | null>(null),
    epoch = useRef(0),
    observedStarts = useRef(new Set<string>());
  let accountKey: string | null = null;
  try {
    accountKey = cantripOsPackageAccountKey();
  } catch {
    /* Authentication is represented below. */
  }
  const current = Boolean(saved.accountKey && saved.accountKey === accountKey);
  const packages = useQuery({
    queryKey: [
      "cantrip-os-packages",
      saved.accountKey,
      instance.id,
      instance.attachmentGeneration,
    ],
    queryFn: () => getCantripOsPackages(instance, saved.accountKey!),
    retry: false,
    enabled: current,
  });
  const history = useInfiniteQuery({
    queryKey: ["cantrip-os-package-operations", saved.accountKey, instance.id],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      getCantripOsPackageOperations(instance.id, pageParam, saved.accountKey!),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    retry: false,
    enabled: current,
  });
  const changed = () => {
    void packages.refetch();
    void history.refetch();
    onChanged();
  };
  function retain(draft: CantripOsPackageDraft) {
    saveCantripOsPackageDraft(draft);
    setSaved({ accountKey: draft.accountKey, draft });
  }
  const mutate = useMutation({
    retry: false,
    mutationFn: async (run: () => Promise<CantripOsPackageSummary>) => {
      if (active.current)
        throw new Error("A package action is already in progress.");
      const selectedEpoch = epoch.current,
        account = cantripOsPackageAccountKey(),
        token = {};
      active.current = token;
      try {
        return { value: await run(), epoch: selectedEpoch, account };
      } finally {
        if (active.current === token) active.current = null;
      }
    },
    onSuccess: ({ value, epoch: returnedEpoch, account }) => {
      if (returnedEpoch !== epoch.current) return;
      try {
        if (account !== cantripOsPackageAccountKey()) return;
      } catch {
        return;
      }
      setResult(value);
      try {
        const pending = readCantripOsPackageDraft(instance.id);
        if (
          pending?.request.operationId === value.operationId &&
          ["ready", "failed"].includes(value.state)
        ) {
          clearCantripOsPackageDraft(instance.id, pending.accountKey);
          setSaved({ accountKey: pending.accountKey, draft: null });
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
        epoch.current++;
        observedStarts.current.clear();
        active.current = null;
        mutate.reset();
        setSaved(readState());
        setReview(null);
        setSelected({});
        setResult(null);
        setAction("upgrade");
        setDefaults(false);
      }),
    [instance.id],
  );
  useEffect(() => {
    epoch.current++;
    observedStarts.current.clear();
    active.current = null;
    mutate.reset();
    setReview(null);
    setSelected({});
    setResult(null);
    setSaved(readState());
  }, [instance.id, instance.attachmentGeneration]);
  async function send(input: CantripOsPackageDraft) {
    const draft = assertCantripOsPackageDraftCurrent(input);
    if (draft.submitted)
      throw new Error(
        "This request was sent already. Check its original operation.",
      );
    await authorizeCantripOsPackageWorker(
      draft.target.workerId,
      draft.accountKey,
    );
    assertCantripOsPackageDraftCurrent(draft);
    const submitted = { ...draft, submitted: true };
    retain(submitted);
    return submitCantripOsPackage(submitted);
  }
  function dismiss() {
    try {
      if (!saved.accountKey)
        throw new Error("An authenticated session is required.");
      clearCantripOsPackageDraft(instance.id, saved.accountKey);
      setSaved({ accountKey: saved.accountKey, draft: null });
    } catch (error) {
      setSaved({ ...saved, error: errorMessage(error) });
    }
  }
  const status = current ? packages.data : undefined,
    target = status?.target;
  const available = status?.available ?? [],
    picked = available.filter((pkg) => selected[pkg.name] === pkg.sha256);
  const entries = current
    ? (history.data?.pages.flatMap((page) => page.items) ?? [])
    : [];
  const historical = result
    ? entries.find((entry) => entry.operationId === result.operationId)
    : undefined;
  const latest =
    historical &&
    (["ready", "failed"].includes(historical.state) ||
      (result &&
        !["ready", "failed"].includes(result.state) &&
        historical.updatedAt > result.updatedAt))
      ? historical
      : result;
  const rows =
    current && latest
      ? [
          latest,
          ...entries.filter(
            (entry) => entry.operationId !== latest.operationId,
          ),
        ]
      : entries;
  const running = rows.find(
    (entry) =>
      entry.state === "running" ||
      entry.state === "admitted" ||
      (entry.state === "unknown" &&
        entry.phase === "start-requested" &&
        !observedStarts.current.has(entry.operationId)),
  );
  useEffect(() => {
    if (
      !current ||
      !running ||
      mutate.isPending ||
      mutate.isError ||
      !saved.accountKey
    )
      return;
    const account = saved.accountKey;
    const timer = setTimeout(() => {
      // The detached installer can start just after its reservation reply.
      // Observe that boundary once; a persistent unknown needs an explicit check.
      if (running.state === "unknown")
        observedStarts.current.add(running.operationId);
      mutate.mutate(() => observeCantripOsPackageOperation(running, account));
    }, 2500);
    return () => clearTimeout(timer);
  }, [
    current,
    running?.operationId,
    running?.updatedAt,
    running?.state,
    running?.phase,
    mutate.isPending,
    mutate.isError,
    saved.accountKey,
  ]);
  const failure = current
    ? (saved.error ??
      (mutate.error && errorMessage(mutate.error)) ??
      (packages.error && errorMessage(packages.error)) ??
      (history.error && errorMessage(history.error)))
    : null;
  return (
    <section
      className="space-y-3 rounded-lg border p-4"
      aria-label="Cantrip integration packages"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium">Cantrip integration packages</h3>
        <Button
          variant="ghost"
          size="sm"
          disabled={!current || mutate.isPending}
          onClick={changed}
        >
          Refresh packages
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Manage the optional Cantrip software on {instance.name}. Configuration
        is preserved by default.
      </p>
      {failure ? (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      ) : null}
      {status?.error ? (
        <p role="status" className="text-sm text-muted-foreground">
          {status.error}
        </p>
      ) : null}
      {target ? (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Verified destination: {instance.name} · {target.architecture}
          </p>
          {cantripOsPackageNameSchema.options.map((name) => {
            const builds = available.filter((pkg) => pkg.name === name),
              installed = status.installed.find((pkg) => pkg.name === name);
            const enabled = Boolean(selected[name]),
              version = installed?.status.split("\t");
            return (
              <div key={name} className="space-y-1 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    aria-label={`Select ${name}`}
                    disabled={!builds.length || mutate.isPending}
                    checked={enabled}
                    onChange={(event) => {
                      if (!event.target.checked) {
                        setSelected((previous) => {
                          const next = { ...previous };
                          delete next[name];
                          return next;
                        });
                        return;
                      }
                      const candidate =
                        builds.find(
                          (pkg) =>
                            pkg.architecture === target.architecture ||
                            pkg.architecture === "all",
                        ) ?? builds[0];
                      if (candidate)
                        setSelected((previous) => ({
                          ...previous,
                          [name]: candidate.sha256,
                        }));
                    }}
                  />
                  {name}
                </label>
                <p className="text-xs text-muted-foreground">
                  Installed:{" "}
                  {installed?.exitCode === 0 && version?.length
                    ? `${version[1] ?? "Unknown version"} · ${version[0]}`
                    : "Not reported"}
                </p>
                {builds.length > 1 ? (
                  <NativeSelect
                    aria-label={`Build for ${name}`}
                    value={selected[name] ?? ""}
                    disabled={mutate.isPending}
                    onChange={(event) =>
                      setSelected((previous) => ({
                        ...previous,
                        [name]: event.target.value,
                      }))
                    }
                  >
                    <option value="">Choose a build</option>
                    {builds.map((pkg) => (
                      <option key={pkg.sha256} value={pkg.sha256}>
                        {pkg.version} · {pkg.architecture} ·{" "}
                        {pkg.sha256.slice(0, 12)}
                      </option>
                    ))}
                  </NativeSelect>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {builds[0]
                      ? `Available: ${builds[0].version} · ${builds[0].architecture} · ${builds[0].sha256.slice(0, 12)}`
                      : "No builds available"}
                  </p>
                )}
              </div>
            );
          })}
          {!available.length ? (
            <p className="text-sm text-muted-foreground">
              No package builds are available from this Worker.
            </p>
          ) : null}
          {status.unavailable ? (
            <p className="text-sm text-muted-foreground">
              {status.unavailable} package build records could not be read.
              Check Worker diagnostics.
            </p>
          ) : null}
          <label className="block space-y-1 text-sm">
            Package action
            <NativeSelect
              aria-label="Package action"
              value={action}
              onChange={(event) => {
                setAction(event.target.value as Intent["action"]);
                setDefaults(false);
              }}
            >
              <option value="upgrade">Update selected packages</option>
              <option value="repair">Repair selected packages</option>
            </NativeSelect>
          </label>
          {action === "repair" ? (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={defaults}
                onChange={(event) => setDefaults(event.target.checked)}
              />
              Use package defaults and retain the original configuration
            </label>
          ) : null}
          <Button
            size="sm"
            disabled={
              mutate.isPending || !picked.length || Boolean(saved.draft)
            }
            onClick={() =>
              setReview({
                target,
                intent: {
                  action,
                  configuration: defaults ? "package-defaults" : "preserve",
                  packages: picked,
                },
                accountKey: saved.accountKey!,
                epoch: epoch.current,
              })
            }
          >
            Review {action === "repair" ? "repair" : "update"}
          </Button>
        </div>
      ) : packages.isFetching ? (
        <p role="status" className="text-sm text-muted-foreground">
          Checking package inventory…
        </p>
      ) : null}
      {review && current ? (
        <div
          className="space-y-2 rounded-md border p-3"
          aria-label="Review package action"
        >
          <h4 className="text-sm font-medium">
            {review.intent.action === "repair" ? "Repair" : "Update"} packages
            on {instance.name}
          </h4>
          <ul className="space-y-1 text-xs">
            {review.intent.packages.map((pkg) => (
              <li key={pkg.name}>
                {pkg.name} {pkg.version} · {pkg.architecture} ·{" "}
                <code>{pkg.sha256}</code>
              </li>
            ))}
          </ul>
          <p className="text-sm">
            {review.intent.configuration === "preserve"
              ? "Keep administrator configuration."
              : "Use the selected packages' defaults; original configuration will be retained."}{" "}
            Managed work in this instance may be interrupted. After
            installation, check recovery and verify your Linux sources.
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={mutate.isPending}
              onClick={() => {
                const chosen = review;
                setReview(null);
                mutate.mutate(async () => {
                  if (
                    chosen.accountKey !== cantripOsPackageAccountKey() ||
                    chosen.epoch !== epoch.current
                  )
                    throw new Error(
                      "The account or server changed. Review the intended package action again.",
                    );
                  if (readCantripOsPackageDraft(instance.id))
                    throw new Error(
                      "Check or dismiss the saved package request first.",
                    );
                  const draft = prepareCantripOsPackageDraft(
                    chosen.target,
                    chosen.intent,
                  );
                  retain(draft);
                  return send(draft);
                });
              }}
            >
              Confirm {review.intent.action === "repair" ? "repair" : "update"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setReview(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {current && saved.draft ? (
        <div
          className="space-y-2 rounded-md border p-3"
          aria-label="Saved package request"
        >
          <p className="text-sm">
            Saved package request <code>{saved.draft.request.operationId}</code>
            .{" "}
            {saved.draft.submitted
              ? "Check the original admission after a lost connection or reload."
              : "This request has not been sent yet."}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={mutate.isPending}
              onClick={() =>
                mutate.mutate(() =>
                  saved.draft!.submitted
                    ? observeCantripOsPackageDraft(saved.draft!)
                    : send(saved.draft!),
                )
              }
            >
              {saved.draft.submitted
                ? "Check saved package request"
                : "Send saved package request"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={mutate.isPending}
              onClick={dismiss}
            >
              Dismiss local reminder
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Dismissing this reminder leaves the operation and its history
            intact.
          </p>
        </div>
      ) : null}
      {rows.length ? (
        <div className="space-y-2" aria-label="Package operation history">
          {rows.map((entry) => (
            <CantripOsPackageEntry
              key={`${saved.accountKey}:${entry.operationId}`}
              entry={entry}
              accountKey={saved.accountKey!}
              pending={mutate.isPending}
              canControl={
                entry.attachmentGeneration === instance.attachmentGeneration &&
                entry.workerId === instance.workerId
              }
              onRun={(run) => mutate.mutate(run)}
            />
          ))}
        </div>
      ) : null}
      {current && history.hasNextPage ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={history.isFetchingNextPage}
          onClick={() => void history.fetchNextPage()}
        >
          Load older package operations
        </Button>
      ) : null}
    </section>
  );
}
