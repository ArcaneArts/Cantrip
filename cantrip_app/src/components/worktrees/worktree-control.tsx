import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import type {
  GitManagedBranch,
  GitStatus,
  ProjectWorktreeCreate,
  ProjectWorktreeSummary,
  WorkerSummary,
} from "@cantrip/protocol";
import { useQuery } from "@tanstack/react-query";
import {
  Check,
  ChevronsUpDown,
  CircleAlert,
  Cpu,
  FolderTree,
  GitBranch,
  GitFork,
  History,
  Loader2,
  Lock,
  Pin,
  PinOff,
  Plus,
  SquareTerminal,
} from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from "@/components/ui/styled-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { getProjectWorktreeBranches } from "@/lib/api";
import { cn } from "@/lib/utils";

export type WorktreeStatusMap = Record<string, GitStatus | undefined>;

export interface WorktreeDetails {
  leaseOwner?: string | null;
  online: boolean;
  status?: GitStatus;
  workerName: string;
  worktree: ProjectWorktreeSummary;
}

export function worktreeHasConflicts(status?: GitStatus): boolean {
  return Boolean(
    status?.files.some(({ indexStatus, worktreeStatus }) =>
      ["AA", "AU", "DD", "DU", "UA", "UD", "UU"].includes(
        `${indexStatus}${worktreeStatus}`,
      ),
    ),
  );
}

export function worktreeTooltip({
  leaseOwner,
  online,
  status,
  workerName,
  worktree,
}: WorktreeDetails): string {
  const state = !online
    ? "Worker offline"
    : worktree.lifecycleState !== "ready"
      ? worktree.lifecycleState
      : !status
        ? "Status unavailable"
        : worktreeHasConflicts(status)
          ? "Conflicts"
          : status.files.length
            ? `${status.files.length} changed file${status.files.length === 1 ? "" : "s"}`
            : "Clean";
  return [
    worktree.name,
    worktree.branch ?? `Detached at ${worktree.head?.slice(0, 8) ?? "unknown"}`,
    `${workerName}${online ? "" : " (offline)"}`,
    state,
    worktree.displayPath,
    leaseOwner ? `Lease: ${leaseOwner}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function workerFor(worktree: ProjectWorktreeSummary, workers: WorkerSummary[]) {
  const worker = workers.find(({ workerId }) => workerId === worktree.workerId);
  return {
    online: worker?.online ?? false,
    workerName: worker?.name ?? worktree.workerId,
  };
}

export function WorkerPlacementIndicator({
  workerId,
  workers,
}: {
  workerId?: string | null;
  workers: WorkerSummary[];
}) {
  if (!workerId || workers.length <= 1) return null;
  const worker = workers.find((candidate) => candidate.workerId === workerId);
  const workerName = worker?.name ?? workerId;
  const online = worker?.online ?? false;
  return (
    <span
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded text-muted-foreground",
        online ? "text-sky-400" : "text-muted-foreground/60",
      )}
      title={`Runs on ${workerName}${online ? "" : " · offline"}`}
    >
      <Cpu className="size-3.5" />
      <span className="sr-only">
        Runs on {workerName}
        {online ? "" : ", offline"}
      </span>
    </span>
  );
}

function DetailRows({ details }: { details: WorktreeDetails }) {
  const conflict = worktreeHasConflicts(details.status);
  const dirty = Boolean(details.status?.files.length);
  return (
    <div className="space-y-2 px-2 py-2 text-xs">
      <div className="flex items-center gap-2">
        <GitFork
          className={cn(
            "size-4 text-violet-500",
            (!details.online || details.worktree.lifecycleState !== "ready") &&
              "text-muted-foreground",
            dirty && "text-amber-500",
            conflict && "text-destructive",
          )}
        />
        <span className="font-medium">{details.worktree.name}</span>
        {details.worktree.locked ? <Lock className="ml-auto size-3" /> : null}
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-muted-foreground">
        <dt>Branch</dt>
        <dd className="truncate text-foreground">
          {details.worktree.branch ??
            `Detached ${details.worktree.head?.slice(0, 8) ?? "HEAD"}`}
        </dd>
        <dt>Worker</dt>
        <dd className="truncate text-foreground">
          {details.workerName}
          {!details.online ? " · offline" : ""}
        </dd>
        <dt>State</dt>
        <dd
          className={cn(
            "truncate text-foreground",
            dirty && "text-amber-500",
            conflict && "text-destructive",
          )}
        >
          {conflict
            ? "Conflicts"
            : dirty
              ? `${details.status!.files.length} changed`
              : !details.online
                ? "Worker offline"
                : details.status
                  ? "Clean"
                  : details.worktree.lifecycleState === "ready"
                    ? "Status unavailable"
                    : details.worktree.lifecycleState}
        </dd>
        <dt>Path</dt>
        <dd className="truncate font-mono text-[10px] text-foreground">
          {details.worktree.displayPath}
        </dd>
        {details.leaseOwner ? (
          <>
            <dt>Lease</dt>
            <dd className="truncate text-foreground">{details.leaseOwner}</dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}

export function WorktreeIndicator({
  leaseOwner,
  status,
  workers,
  worktree,
}: {
  leaseOwner?: string | null;
  status?: GitStatus;
  workers: WorkerSummary[];
  worktree?: ProjectWorktreeSummary;
}) {
  if (!worktree) return null;
  if (worktree.isPrimary) {
    return (
      <WorkerPlacementIndicator
        workerId={worktree.workerId}
        workers={workers}
      />
    );
  }
  const worker = workerFor(worktree, workers);
  const details = { ...worker, leaseOwner, status, worktree };
  const conflict = worktreeHasConflicts(status);
  const dirty = Boolean(status?.files.length);
  const unavailable = !worker.online || worktree.lifecycleState !== "ready";
  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <button
          type="button"
          title={worktreeTooltip(details)}
          className={cn(
            "relative grid size-6 shrink-0 place-items-center rounded text-violet-500 hover:bg-violet-500/10 focus:outline-none focus:ring-2 focus:ring-ring",
            unavailable && "text-muted-foreground",
            dirty && "text-amber-500",
            conflict && "text-destructive",
          )}
          onClick={(event) => event.stopPropagation()}
        >
          <GitFork className="size-3.5" />
          {dirty ? (
            <span
              className={cn(
                "absolute right-0.5 top-0.5 size-1.5 rounded-full bg-amber-500 ring-1 ring-background",
                conflict && "bg-destructive",
              )}
            />
          ) : null}
          <span className="sr-only">Show {worktree.name} details</span>
        </button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <StyledDropdownMenuContent
          align="end"
          sideOffset={4}
          className="min-w-64"
        >
          <DetailRows details={details} />
        </StyledDropdownMenuContent>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

export interface WorktreeControlActions {
  chatMode?: "agent-managed" | "pinned";
  disabled?: boolean;
  error?: string | null;
  pending?: boolean;
  onCreate(): void;
  onOpenExplorer?(): void;
  onOpenHistory?(): void;
  onOpenTerminal?(): void;
  onSelect(worktreeId: string): void;
  onSetChatMode?(mode: "agent-managed" | "pinned"): void;
}

export function worktreeExistingBranchOptions(
  branches: readonly GitManagedBranch[],
): GitManagedBranch[] {
  return branches
    .filter(({ kind }) => kind === "local")
    .sort((left, right) => left.name.localeCompare(right.name));
}

function ExistingBranchCombobox({
  branches,
  error,
  loading,
  onChange,
  value,
}: {
  branches: GitManagedBranch[];
  error: boolean;
  loading: boolean;
  onChange(value: string): void;
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = branches.find(({ name }) => name === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between px-3 font-mono text-xs font-normal"
        >
          <span className="truncate">
            {selected?.name ?? "Select an existing branch"}
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] p-0"
      >
        <Command>
          <CommandInput placeholder="Search branches…" />
          <CommandList>
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Loading branches…
              </div>
            ) : null}
            {error ? (
              <div className="py-6 text-center text-sm text-destructive">
                Could not load branches.
              </div>
            ) : null}
            {!loading && !error ? (
              <>
                <CommandEmpty>No branches found.</CommandEmpty>
                <CommandGroup>
                  {branches.map((candidate) => (
                    <CommandItem
                      key={candidate.fullRef}
                      value={candidate.name}
                      disabled={Boolean(candidate.worktree)}
                      onSelect={() => {
                        onChange(candidate.name);
                        setOpen(false);
                      }}
                    >
                      <Check
                        className={cn(
                          "size-3.5 shrink-0",
                          candidate.name === value
                            ? "opacity-100"
                            : "opacity-0",
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">
                        {candidate.name}
                      </span>
                      {candidate.worktree ? (
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          In {candidate.worktree.label}
                        </span>
                      ) : null}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function WorktreeControl({
  actions,
  currentWorktreeId,
  leaseOwner,
  statuses,
  workers,
  worktrees,
}: {
  actions: WorktreeControlActions;
  currentWorktreeId: string;
  leaseOwner?: string | null;
  statuses: WorktreeStatusMap;
  workers: WorkerSummary[];
  worktrees: ProjectWorktreeSummary[];
}) {
  const current = worktrees.find(({ id }) => id === currentWorktreeId);
  if (!current) return null;
  const worker = workerFor(current, workers);
  const details = {
    ...worker,
    leaseOwner,
    status: statuses[current.id],
    worktree: current,
  };
  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 max-w-48 gap-1.5 px-2 text-xs text-muted-foreground"
          title={worktreeTooltip(details)}
        >
          {actions.pending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <GitFork
              className={cn(
                "size-3.5",
                !current.isPrimary && "text-violet-500",
              )}
            />
          )}
          <span className="truncate">{current.name}</span>
          {actions.chatMode === "pinned" ? <Pin className="size-3" /> : null}
        </Button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <StyledDropdownMenuContent
          align="end"
          sideOffset={4}
          className="min-w-64"
        >
          <DetailRows details={details} />
          <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />
          <DropdownMenuPrimitive.Label className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Worktrees
          </DropdownMenuPrimitive.Label>
          {worktrees.map((worktree) => (
            <StyledDropdownMenuItem
              key={worktree.id}
              disabled={actions.disabled || worktree.lifecycleState !== "ready"}
              onSelect={() => actions.onSelect(worktree.id)}
            >
              {worktree.isPrimary ? (
                <GitBranch className="size-4" />
              ) : (
                <GitFork className="size-4 text-violet-500" />
              )}
              <span className="min-w-0 flex-1 truncate">{worktree.name}</span>
              {worktree.id === currentWorktreeId ? (
                <Check className="size-3.5" />
              ) : null}
            </StyledDropdownMenuItem>
          ))}
          <StyledDropdownMenuItem
            disabled={actions.disabled}
            onSelect={actions.onCreate}
          >
            <Plus className="size-4" /> Create worktree…
          </StyledDropdownMenuItem>
          {actions.onSetChatMode ? (
            <>
              <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />
              <StyledDropdownMenuItem
                disabled={actions.disabled}
                onSelect={() =>
                  actions.onSetChatMode!(
                    actions.chatMode === "pinned" ? "agent-managed" : "pinned",
                  )
                }
              >
                {actions.chatMode === "pinned" ? (
                  <PinOff className="size-4" />
                ) : (
                  <Pin className="size-4" />
                )}
                {actions.chatMode === "pinned"
                  ? "Return to Agent managed"
                  : "Pin to this worktree"}
              </StyledDropdownMenuItem>
              {actions.onOpenTerminal ? (
                <StyledDropdownMenuItem onSelect={actions.onOpenTerminal}>
                  <SquareTerminal className="size-4" /> Open Terminal here
                </StyledDropdownMenuItem>
              ) : null}
              {actions.onOpenExplorer ? (
                <StyledDropdownMenuItem onSelect={actions.onOpenExplorer}>
                  <FolderTree className="size-4" /> Open Explorer here
                </StyledDropdownMenuItem>
              ) : null}
              {actions.onOpenHistory ? (
                <StyledDropdownMenuItem onSelect={actions.onOpenHistory}>
                  <History className="size-4" /> Open in Git
                </StyledDropdownMenuItem>
              ) : null}
            </>
          ) : null}
          {actions.error ? (
            <>
              <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />
              <div className="flex max-w-72 gap-2 px-2 py-1.5 text-xs text-destructive">
                <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span>{actions.error}</span>
              </div>
            </>
          ) : null}
        </StyledDropdownMenuContent>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

export function WorktreeCreateDialog({
  open,
  pending,
  projectId,
  sourceWorktreeId,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  pending: boolean;
  projectId: string | null;
  sourceWorktreeId: string | null;
  onOpenChange(open: boolean): void;
  onSubmit(input: ProjectWorktreeCreate): Promise<void>;
}) {
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [baseRevision, setBaseRevision] = useState("");
  const [intent, setIntent] = useState<
    "newBranch" | "existingBranch" | "detached"
  >("newBranch");
  const [error, setError] = useState<string | null>(null);
  const branchInventory = useQuery({
    enabled:
      open &&
      intent === "existingBranch" &&
      Boolean(projectId && sourceWorktreeId),
    queryFn: () => getProjectWorktreeBranches(projectId!, sourceWorktreeId!),
    queryKey: ["worktree-branches", projectId, sourceWorktreeId],
    retry: false,
    staleTime: 15_000,
  });
  const existingBranches = worktreeExistingBranchOptions(
    branchInventory.data?.branches ?? [],
  );
  useEffect(() => {
    if (!open) {
      setName("");
      setBranch("");
      setBaseRevision("");
      setIntent("newBranch");
      setError(null);
    }
  }, [open]);
  const valid =
    name.trim() &&
    (intent === "detached" ? baseRevision.trim() : branch.trim());
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid || pending) return;
    const mode: ProjectWorktreeCreate["mode"] =
      intent === "newBranch"
        ? {
            type: "newBranch",
            branch: branch.trim(),
            startPoint: baseRevision.trim() || null,
          }
        : intent === "existingBranch"
          ? { type: "existingBranch", branch: branch.trim() }
          : { type: "detached", revision: baseRevision.trim() };
    try {
      setError(null);
      await onSubmit({ name: name.trim(), mode });
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Create worktree</DialogTitle>
            <DialogDescription>
              The worker chooses and validates the checkout path. Removing the
              worktree later will not delete its branch.
            </DialogDescription>
          </DialogHeader>
          <label className="block space-y-1.5 text-sm">
            <span>Name</span>
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Fix authentication"
              className="h-9 w-full rounded-md border bg-background px-3 outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
          <label className="block space-y-1.5 text-sm">
            <span>Checkout</span>
            <select
              value={intent}
              onChange={(event) => {
                setBranch("");
                setIntent(
                  event.target.value as
                    "newBranch" | "existingBranch" | "detached",
                );
              }}
              className="h-9 w-full rounded-md border bg-background px-3 outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="newBranch">New branch</option>
              <option value="existingBranch">Existing branch</option>
              <option value="detached">Detached revision</option>
            </select>
          </label>
          {intent === "existingBranch" ? (
            <label className="block space-y-1.5 text-sm">
              <span>Branch</span>
              <ExistingBranchCombobox
                branches={existingBranches}
                error={branchInventory.isError}
                loading={branchInventory.isLoading}
                value={branch}
                onChange={setBranch}
              />
            </label>
          ) : intent === "detached" ? null : (
            <label className="block space-y-1.5 text-sm">
              <span>Branch</span>
              <input
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                placeholder="agent/manual/fix-auth"
                className="h-9 w-full rounded-md border bg-background px-3 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
          )}
          {intent === "existingBranch" ? null : (
            <label className="block space-y-1.5 text-sm">
              <span>
                {intent === "detached"
                  ? "Revision"
                  : "Base revision (optional)"}
              </span>
              <input
                value={baseRevision}
                onChange={(event) => setBaseRevision(event.target.value)}
                placeholder={intent === "detached" ? "HEAD~1" : "origin/main"}
                className="h-9 w-full rounded-md border bg-background px-3 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
          )}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || pending}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
