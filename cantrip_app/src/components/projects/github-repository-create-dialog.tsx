import type {
  GithubRepository,
  GithubRepositoryVisibility,
} from "@cantrip/protocol";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Building2, Globe2, Loader2, Lock, User } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

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
import { createGithubRepository, getGithubRepositoryOwners } from "@/lib/api";

function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The GitHub repository could not be created.";
}

export function GithubRepositoryCreateDialog({
  login,
  onCreated,
  onOpenChange,
  open,
  workerId,
}: {
  login: string;
  onCreated(repository: GithubRepository): Promise<void> | void;
  onOpenChange(open: boolean): void;
  open: boolean;
  workerId: string;
}) {
  const [owner, setOwner] = useState(login);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] =
    useState<GithubRepositoryVisibility>("private");
  const owners = useQuery({
    enabled: open,
    queryFn: () => getGithubRepositoryOwners(workerId),
    queryKey: ["github-repository-owners", workerId],
    staleTime: 30_000,
  });
  const createRepository = useMutation({
    mutationFn: async () => {
      const repository = await createGithubRepository(workerId, {
        owner,
        name,
        description,
        visibility,
      });
      await onCreated(repository);
      return repository;
    },
    onSuccess: () => onOpenChange(false),
  });

  useEffect(() => {
    if (!open) return;
    setOwner(login);
    setName("");
    setDescription("");
    setVisibility("private");
    createRepository.reset();
  }, [login, open]);

  useEffect(() => {
    if (
      open &&
      owners.data?.length &&
      !owners.data.some(({ login: candidate }) => candidate === owner)
    ) {
      setOwner(owners.data[0]!.login);
    }
  }, [open, owner, owners.data]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!owner || !name.trim() || createRepository.isPending) return;
    createRepository.mutate();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!createRepository.isPending) onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create GitHub repository</DialogTitle>
          <DialogDescription>
            Create the repository with the worker&apos;s GitHub account, then
            add it to Cantrip and the selected workspaces.
          </DialogDescription>
        </DialogHeader>

        <form className="grid gap-5" onSubmit={submit}>
          <label className="grid gap-2 text-sm font-medium">
            Owner
            <div className="relative">
              <Building2 className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <select
                aria-label="Repository owner"
                className="h-9 w-full appearance-none rounded-md border border-input bg-transparent pl-10 pr-8 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
                disabled={owners.isLoading || createRepository.isPending}
                value={owner}
                onChange={(event) => setOwner(event.target.value)}
              >
                {(owners.data ?? [{ login, kind: "user" as const }]).map(
                  (candidate) => (
                    <option key={candidate.login} value={candidate.login}>
                      {candidate.login} ·{" "}
                      {candidate.kind === "organization"
                        ? "Organization"
                        : "Personal account"}
                    </option>
                  ),
                )}
              </select>
            </div>
            {owners.isError ? (
              <span className="font-normal text-destructive">
                {errorText(owners.error)}
              </span>
            ) : null}
          </label>

          <label className="grid gap-2 text-sm font-medium">
            Repository name
            <Input
              autoFocus
              disabled={createRepository.isPending}
              maxLength={100}
              placeholder="my-project"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>

          <label className="grid gap-2 text-sm font-medium">
            Description
            <textarea
              className="min-h-24 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
              disabled={createRepository.isPending}
              maxLength={350}
              placeholder="What is this repository for?"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
            <span className="text-right text-[11px] font-normal tabular-nums text-muted-foreground">
              {description.length}/350
            </span>
          </label>

          <fieldset className="grid gap-2">
            <legend className="text-sm font-medium">Visibility</legend>
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant={visibility === "private" ? "default" : "outline"}
                aria-pressed={visibility === "private"}
                disabled={createRepository.isPending}
                onClick={() => setVisibility("private")}
              >
                <Lock className="size-4" />
                Private
              </Button>
              <Button
                type="button"
                variant={visibility === "public" ? "default" : "outline"}
                aria-pressed={visibility === "public"}
                disabled={createRepository.isPending}
                onClick={() => setVisibility("public")}
              >
                <Globe2 className="size-4" />
                Public
              </Button>
            </div>
          </fieldset>

          {createRepository.isError ? (
            <p className="text-sm text-destructive" role="alert">
              {errorText(createRepository.error)}
            </p>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={createRepository.isPending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                createRepository.isPending ||
                owners.isError ||
                !owner ||
                !name.trim()
              }
            >
              {createRepository.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : owner === login ? (
                <User className="size-4" />
              ) : (
                <Building2 className="size-4" />
              )}
              {createRepository.isPending
                ? "Creating and adding…"
                : "Create repository"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
