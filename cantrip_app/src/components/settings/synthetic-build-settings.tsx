import {
  AlertTriangle,
  ChevronDown,
  GitCommit,
  Hammer,
  Loader2,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { openSyntheticBuildProgressWindow } from "@/lib/desktop-popout";
import { openExternalUrl } from "@/lib/external-url";
import { desktopUpdateClient } from "@/lib/desktop-update";
import {
  normalizeSyntheticBuildError,
  syntheticBuildClient,
  type CachedSyntheticBuild,
  type SyntheticBuildClient,
  type SyntheticCommit,
  type SyntheticBuildIdentity,
  type SyntheticPrerequisiteScan,
} from "@/lib/synthetic-build";

type Stage = "commits" | "prerequisites" | "warning";

export function SyntheticBuildCache({
  client = syntheticBuildClient,
}: {
  client?: SyntheticBuildClient;
}) {
  const [builds, setBuilds] = useState<CachedSyntheticBuild[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [identity, setIdentity] = useState<SyntheticBuildIdentity | null>(null);
  const [cacheMessage, setCacheMessage] = useState<string | null>(null);

  async function install(build: CachedSyntheticBuild) {
    try {
      const activeWork = await desktopUpdateClient.getActiveWork();
      const total = Object.values(activeWork).reduce(
        (sum, value) => sum + value,
        0,
      );
      if (
        total > 0 &&
        !window.confirm(
          `Installing will stop ${total} active Cantrip operation(s). Continue?`,
        )
      )
        return;
      await client.install(build.id, activeWork, true);
    } catch (reason) {
      setError(normalizeSyntheticBuildError(reason).message);
    }
  }

  useEffect(() => {
    if (!client.isSupportedEnvironment()) return;
    void Promise.all([client.cached(), client.identity()])
      .then(([nextBuilds, nextIdentity]) => {
        setBuilds(nextBuilds);
        setIdentity(nextIdentity);
      })
      .catch((reason: unknown) =>
        setError(normalizeSyntheticBuildError(reason).message),
      );
  }, [client]);

  if (!client.isSupportedEnvironment()) return null;
  return (
    <section className="border-t" aria-labelledby="cached-synthetic-builds">
      {identity ? (
        <p className="border-b px-3 py-2.5 text-sm">
          Installed version{" "}
          <span className="font-mono">{identity.version}</span>{" "}
          <span className="text-muted-foreground">
            · Synthetic build · {identity.commitSha.slice(0, 7)}
          </span>
        </p>
      ) : null}
      <h4
        id="cached-synthetic-builds"
        className="border-b bg-muted/25 px-3 py-1.5 text-[11px] font-semibold uppercase text-muted-foreground"
      >
        Local synthetic builds
      </h4>
      {error ? (
        <p className="px-3 py-3 text-sm text-destructive">{error}</p>
      ) : (
        builds.map((build) => (
          <div
            key={build.id}
            className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b px-3 py-2.5"
          >
            <div className="min-w-0">
              <div className="font-mono text-sm">
                {build.version}{" "}
                <span className="text-xs text-muted-foreground">
                  Synthetic build · {build.commitSha.slice(0, 7)}
                </span>
              </div>
              <div className="text-xs text-muted-foreground">
                {new Date(build.builtAt).toLocaleString()} ·{" "}
                {(build.sizeBytes / 1_048_576).toFixed(0)} MB
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void install(build)}
            >
              Install
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label={`Delete ${build.version}`}
              onClick={() =>
                void client
                  .deleteCached(build.id)
                  .then(() =>
                    setBuilds((current) =>
                      current.filter((item) => item.id !== build.id),
                    ),
                  )
              }
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))
      )}
      <div className="flex items-center gap-2 border-t px-3 py-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void client.openCache()}
        >
          Open cache folder
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void client
              .cleanCache()
              .then((bytes) =>
                setCacheMessage(`${(bytes / 1_048_576).toFixed(0)} MB removed`),
              )
              .catch((reason) =>
                setError(normalizeSyntheticBuildError(reason).message),
              )
          }
        >
          Clean unused build cache
        </Button>
        {cacheMessage ? (
          <span className="text-xs text-muted-foreground">{cacheMessage}</span>
        ) : null}
      </div>
    </section>
  );
}

export function selectDefaultSyntheticCommit(commits: SyntheticCommit[]) {
  return (
    commits.find((commit) => commit.buildable !== false) ?? commits[0] ?? null
  );
}

export function SyntheticBuildSettings({
  client = syntheticBuildClient,
}: {
  client?: SyntheticBuildClient;
}) {
  const [available, setAvailable] = useState(false);
  const [activeBuild, setActiveBuild] = useState(false);
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<Stage>("commits");
  const [commits, setCommits] = useState<SyntheticCommit[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<SyntheticCommit | null>(null);
  const [scan, setScan] = useState<SyntheticPrerequisiteScan | null>(null);
  const [cachedTarget, setCachedTarget] = useState<CachedSyntheticBuild | null>(
    null,
  );
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client.isSupportedEnvironment()) return;
    void Promise.all([client.capability(), client.status()]).then(
      ([capability, status]) => {
        setAvailable(capability.available);
        setActiveBuild(
          status.job?.state === "queued" || status.job?.state === "running",
        );
      },
    );
  }, [client]);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return commits;
    return commits.filter((commit) =>
      `${commit.sha} ${commit.subject} ${commit.authorName}`
        .toLowerCase()
        .includes(query),
    );
  }, [commits, search]);

  if (!available) return null;

  async function load(first = false) {
    setBusy(true);
    setError(null);
    try {
      const status = await client.status();
      if (
        first &&
        status.job?.state &&
        ["queued", "running"].includes(status.job.state)
      ) {
        setOpen(false);
        await openSyntheticBuildProgressWindow();
        return;
      }
      const page = await client.listCommits(
        first ? undefined : (cursor ?? undefined),
      );
      setCommits((current) =>
        first ? page.commits : [...current, ...page.commits],
      );
      setCursor(page.nextCursor);
      if (first) setSelected(selectDefaultSyntheticCommit(page.commits));
    } catch (reason) {
      setError(normalizeSyntheticBuildError(reason).message);
    } finally {
      setBusy(false);
    }
  }

  async function continueFromCommit() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const target = await client.resolveTarget(selected.sha);
      setSelected(target);
      const cached = (await client.cached()).find(
        (build) => build.commitSha === target.sha,
      );
      if (cached) {
        setCachedTarget(cached);
        setStage("warning");
        return;
      }
      setCachedTarget(null);
      const nextScan = await client.scanPrerequisites(target.sha);
      setScan(nextScan);
      setStage(nextScan.ready ? "warning" : "prerequisites");
    } catch (reason) {
      setError(normalizeSyntheticBuildError(reason).message);
    } finally {
      setBusy(false);
    }
  }

  async function checkAgain() {
    if (!selected) return;
    setBusy(true);
    try {
      const nextScan = await client.scanPrerequisites(selected.sha);
      setScan(nextScan);
      if (nextScan.ready) setStage("warning");
    } catch (reason) {
      setError(normalizeSyntheticBuildError(reason).message);
    } finally {
      setBusy(false);
    }
  }

  async function installPrerequisites() {
    if (!selected || !scan) return;
    setBusy(true);
    setError(null);
    try {
      const nextScan = await client.installPrerequisites(
        selected.sha,
        scan.prerequisites
          .filter((item) => item.status !== "ready")
          .map((item) => item.id),
      );
      setScan(nextScan);
    } catch (reason) {
      setError(normalizeSyntheticBuildError(reason).message);
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    if (!selected) return;
    setBusy(true);
    try {
      if (cachedTarget) {
        const activeWork = await desktopUpdateClient.getActiveWork();
        const total = Object.values(activeWork).reduce(
          (sum, value) => sum + value,
          0,
        );
        if (
          total > 0 &&
          !window.confirm(
            `Installing will stop ${total} active Cantrip operation(s). Continue?`,
          )
        ) {
          setBusy(false);
          return;
        }
        await client.install(cachedTarget.id, activeWork, true);
        setOpen(false);
        return;
      }
      await client.start(selected.sha);
      setActiveBuild(true);
      setOpen(false);
      await openSyntheticBuildProgressWindow();
    } catch (reason) {
      setError(normalizeSyntheticBuildError(reason).message);
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => {
          setOpen(true);
          setStage("commits");
          void load(true);
        }}
      >
        <Hammer className="size-3.5" />{" "}
        {activeBuild ? "View Build" : "Build Update"}
      </Button>
      <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
        <DialogContent
          className="flex max-h-[80vh] max-w-2xl flex-col"
          showClose={!busy}
        >
          <DialogHeader>
            <DialogTitle>
              {stage === "commits"
                ? "Build update"
                : stage === "prerequisites"
                  ? "Build prerequisites"
                  : "Confirm synthetic build"}
            </DialogTitle>
            <DialogDescription>
              {stage === "commits"
                ? "Choose a commit from main. The latest buildable commit is selected by default."
                : stage === "prerequisites"
                  ? "Install or update the required build tools, then check again."
                  : "Cantrip will build and install this historical source on this machine."}
            </DialogDescription>
          </DialogHeader>

          {stage === "commits" ? (
            <div className="min-h-0 space-y-3">
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search commits"
              />
              <div className="max-h-[45vh] overflow-y-auto border-y">
                {visible.map((commit) => (
                  <button
                    type="button"
                    key={commit.sha}
                    disabled={commit.buildable === false}
                    className={`flex w-full gap-3 border-b px-2 py-2 text-left text-sm hover:bg-muted/50 disabled:opacity-50 ${selected?.sha === commit.sha ? "bg-muted" : ""}`}
                    onClick={() => setSelected(commit)}
                  >
                    <GitCommit className="mt-0.5 size-4 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{commit.subject}</span>
                      <span className="block font-mono text-xs text-muted-foreground">
                        {commit.shortSha} · {commit.authorName} ·{" "}
                        {new Date(commit.authoredAt).toLocaleDateString()}
                      </span>
                    </span>
                  </button>
                ))}
                {cursor ? (
                  <Button
                    className="my-2 ml-2"
                    size="sm"
                    variant="ghost"
                    pending={busy}
                    onClick={() => void load(false)}
                  >
                    <ChevronDown className="size-4" /> Load more
                  </Button>
                ) : null}
              </div>
            </div>
          ) : stage === "prerequisites" ? (
            <div className="max-h-[50vh] overflow-y-auto border-y">
              {scan?.prerequisites.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between gap-4 border-b px-2 py-3 text-sm"
                >
                  <div>
                    <div className="font-medium">{item.label}</div>
                    <div className="text-xs text-muted-foreground">
                      {item.message ?? `Requires ${item.requiredVersion}`}
                    </div>
                  </div>
                  {item.status === "ready" ? (
                    <span className="text-xs text-emerald-500">Ready</span>
                  ) : item.installUrl ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void openExternalUrl(item.installUrl!)}
                    >
                      Install
                    </Button>
                  ) : (
                    <span className="text-xs text-amber-500">
                      Needs attention
                    </span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
              <div className="flex gap-2 font-medium">
                <AlertTriangle className="size-4" /> This can take tens of
                minutes
              </div>
              <p className="mt-2 text-muted-foreground">
                {cachedTarget
                  ? "A verified local artifact already exists, so Cantrip will install it without rebuilding. It is a local synthetic build, not an official signed or notarized release."
                  : "The build downloads source and dependencies, uses the selected commit's build scripts, and may consume substantial disk and network bandwidth. It is a local synthetic build, not an official signed or notarized Cantrip release."}
              </p>
              <dl className="mt-3 grid grid-cols-[7rem_1fr] gap-1 text-xs">
                <dt>Version</dt>
                <dd className="font-mono">
                  {selected?.syntheticVersion ?? "Resolved at build time"}
                </dd>
                <dt>Commit</dt>
                <dd className="break-all font-mono">{selected?.sha}</dd>
                <dt>Subject</dt>
                <dd>{selected?.subject}</dd>
              </dl>
            </div>
          )}

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            {stage !== "commits" ? (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  setStage(
                    stage === "warning" && !scan?.ready
                      ? "prerequisites"
                      : "commits",
                  )
                }
              >
                Back
              </Button>
            ) : null}
            {stage === "commits" ? (
              <Button
                pending={busy}
                pendingLabel="Checking…"
                disabled={!selected}
                onClick={() => void continueFromCommit()}
              >
                Continue
              </Button>
            ) : stage === "prerequisites" ? (
              <>
                <Button
                  variant="outline"
                  pending={busy}
                  pendingLabel="Opening installers…"
                  onClick={() => void installPrerequisites()}
                >
                  Install prerequisites
                </Button>
                <Button
                  pending={busy}
                  pendingLabel="Checking…"
                  onClick={() => void checkAgain()}
                >
                  Check again
                </Button>
              </>
            ) : (
              <Button
                pending={busy}
                pendingLabel={
                  cachedTarget ? "Opening installer…" : "Starting build…"
                }
                onClick={() => void start()}
              >
                {cachedTarget ? "Install cached build" : "Build and install"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
