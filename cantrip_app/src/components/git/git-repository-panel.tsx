import type {
  GitRemoteAction,
  GitRemoteSummary,
  GitTagAction,
  GitTagSummary,
  GithubReleaseCreate,
} from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ExternalLink,
  Loader2,
  Pencil,
  Plus,
  Search,
  Server,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useId,
  useMemo,
  useState,
} from "react";

import { Button } from "@/components/ui/button";
import { ContentEmpty, ContentLoading } from "@/components/ui/content-state";
import { InlineAlert } from "@/components/ui/inline-alert";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  applyProjectWorktreeRemoteAction,
  applyProjectWorktreeTagAction,
  createProjectWorktreeGithubRelease,
  getProjectWorktreeGithubRelease,
  getProjectWorktreeGithubReleases,
  getProjectWorktreeRemotes,
  getProjectWorktreeTag,
  getProjectWorktreeTags,
  previewProjectWorktreeRemoteAction,
  previewProjectWorktreeTagAction,
} from "@/lib/api";
import { cn } from "@/lib/utils";

import { GitLfsPanel } from "./git-lfs-panel";
import { GitSubmodulePanel } from "./git-submodule-panel";

type Section = "remotes" | "submodules" | "lfs" | "tags" | "releases";
type ReviewedAction =
  | { kind: "remote"; action: GitRemoteAction }
  | { kind: "tag"; action: GitTagAction };
type RemoteEditor =
  | { type: "add"; name: string; fetchUrl: string; pushUrl: string }
  | {
      type: "edit";
      remote: GitRemoteSummary;
      fetchUrl: string;
      pushUrl: string;
    }
  | { type: "defaults"; fetchRemote: string; pushRemote: string };
type TagEditor = {
  name: string;
  target: string;
  annotated: boolean;
  message: string;
};

export function remoteActionDescription(action: GitRemoteAction): string {
  switch (action.type) {
    case "add":
      return `Add remote ${action.name}.`;
    case "edit":
      return `Update the fetch and push URLs for ${action.name}.`;
    case "remove":
      return `Remove remote ${action.name} from this repository.`;
    case "setDefaults":
      return `Use ${action.fetchRemote ?? "Git's default"} for fetch and ${action.pushRemote ?? "Git's default"} for push.`;
    case "fetch":
      return `${action.prune ? "Fetch and prune" : "Fetch"} ${action.remote}.`;
  }
}

export function filterRepositoryTags(
  tags: GitTagSummary[],
  search: string,
): GitTagSummary[] {
  const query = search.trim().toLocaleLowerCase();
  if (!query) return tags;
  return tags.filter(
    (tag) =>
      tag.name.toLocaleLowerCase().includes(query) ||
      tag.subject.toLocaleLowerCase().includes(query) ||
      tag.targetHash.toLocaleLowerCase().startsWith(query),
  );
}

export function releaseDraftFromTags(
  tags: GitTagSummary[],
): GithubReleaseCreate {
  const tagName = tags[0]?.name ?? "";
  return {
    tagName,
    name: tagName,
    body: "",
    draft: true,
    prerelease: false,
  };
}

function remoteActionFromEditor(editor: RemoteEditor): GitRemoteAction {
  if (editor.type === "defaults") {
    return {
      type: "setDefaults",
      fetchRemote: editor.fetchRemote || null,
      pushRemote: editor.pushRemote || null,
    };
  }
  return {
    type: editor.type,
    name: editor.type === "add" ? editor.name.trim() : editor.remote.name,
    fetchUrl: editor.fetchUrl.trim(),
    pushUrl: editor.pushUrl.trim() || null,
  };
}

function signatureLabel(tag: GitTagSummary): string {
  const format = tag.signature.format
    ? tag.signature.format === "x509"
      ? "X.509"
      : tag.signature.format.toUpperCase()
    : null;
  switch (tag.signature.status) {
    case "valid":
      return format ? `${format} verified` : "verified";
    case "valid-unknown":
      return format ? `${format} untrusted` : "valid signature";
    case "unsigned":
      return "unsigned";
    default:
      return format
        ? `${format} ${tag.signature.status}`
        : tag.signature.status;
  }
}

export function GitRepositoryPanel({
  githubEnabled,
  onClose,
  projectId,
  worktreeId,
}: {
  githubEnabled: boolean;
  onClose(): void;
  projectId: string;
  worktreeId: string;
}) {
  const queryClient = useQueryClient();
  const releaseTagOptionsId = useId();
  const [section, setSection] = useState<Section>("remotes");
  const [search, setSearch] = useState("");
  const [remoteEditor, setRemoteEditor] = useState<RemoteEditor | null>(null);
  const [tagEditor, setTagEditor] = useState<TagEditor | null>(null);
  const [releaseEditor, setReleaseEditor] =
    useState<GithubReleaseCreate | null>(null);
  const [selectedReleaseId, setSelectedReleaseId] = useState<number | null>(
    null,
  );
  const [reviewed, setReviewed] = useState<ReviewedAction | null>(null);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);

  const remotes = useQuery({
    queryKey: ["worktree-remotes", projectId, worktreeId],
    queryFn: () => getProjectWorktreeRemotes(projectId, worktreeId),
  });
  const tags = useQuery({
    enabled:
      section === "tags" || section === "releases" || selectedTag !== null,
    queryKey: ["worktree-tags", projectId, worktreeId],
    queryFn: () => getProjectWorktreeTags(projectId, worktreeId),
  });
  const tagDetail = useQuery({
    enabled: Boolean(selectedTag),
    queryKey: ["worktree-tag", projectId, worktreeId, selectedTag],
    queryFn: () => getProjectWorktreeTag(projectId, worktreeId, selectedTag!),
  });
  const releases = useQuery({
    enabled: githubEnabled && section === "releases",
    queryKey: ["worktree-releases", projectId, worktreeId],
    queryFn: () => getProjectWorktreeGithubReleases(projectId, worktreeId),
  });
  const releaseDetail = useQuery({
    enabled: selectedReleaseId !== null,
    queryKey: ["worktree-release", projectId, worktreeId, selectedReleaseId],
    queryFn: () =>
      getProjectWorktreeGithubRelease(
        projectId,
        worktreeId,
        selectedReleaseId!,
      ),
  });
  const previewRemote = useMutation({
    mutationFn: (action: GitRemoteAction) =>
      previewProjectWorktreeRemoteAction(projectId, worktreeId, action),
  });
  const previewTag = useMutation({
    mutationFn: (action: GitTagAction) =>
      previewProjectWorktreeTagAction(projectId, worktreeId, action),
  });
  const apply = useMutation({
    mutationFn: async () => {
      if (!reviewed) throw new Error("Review an action first.");
      if (reviewed.kind === "remote") {
        if (!previewRemote.data) throw new Error("Remote preview is missing.");
        return {
          kind: "remote" as const,
          result: await applyProjectWorktreeRemoteAction(
            projectId,
            worktreeId,
            reviewed.action,
            previewRemote.data.token,
          ),
        };
      }
      if (!previewTag.data) throw new Error("Tag preview is missing.");
      return {
        kind: "tag" as const,
        result: await applyProjectWorktreeTagAction(
          projectId,
          worktreeId,
          reviewed.action,
          previewTag.data.token,
        ),
      };
    },
    onSuccess: ({ kind, result }) => {
      if (kind === "remote") {
        queryClient.setQueryData(
          ["worktree-remotes", projectId, worktreeId],
          result.remotes,
        );
        void queryClient.invalidateQueries({
          queryKey: ["worktree-branches", projectId, worktreeId],
        });
        void queryClient.invalidateQueries({
          queryKey: ["worktree-tags", projectId, worktreeId],
        });
      } else {
        queryClient.setQueryData(
          ["worktree-tags", projectId, worktreeId],
          result.tags,
        );
        setSelectedTag(null);
      }
      queryClient.setQueryData(
        ["worktree-status", projectId, worktreeId],
        result.status,
      );
      void queryClient.invalidateQueries({
        queryKey: ["worktree-history", projectId, worktreeId],
      });
      setReviewed(null);
      previewRemote.reset();
      previewTag.reset();
    },
  });
  const createRelease = useMutation({
    mutationFn: (input: GithubReleaseCreate) =>
      createProjectWorktreeGithubRelease(projectId, worktreeId, input),
    onSuccess: () => {
      setReleaseEditor(null);
      void queryClient.invalidateQueries({
        queryKey: ["worktree-releases", projectId, worktreeId],
      });
    },
  });

  const review = (next: ReviewedAction) => {
    setReviewed(next);
    apply.reset();
    previewRemote.reset();
    previewTag.reset();
    if (next.kind === "remote") previewRemote.mutate(next.action);
    else previewTag.mutate(next.action);
  };
  const submitRemote = (event: FormEvent) => {
    event.preventDefault();
    if (!remoteEditor) return;
    const action = remoteActionFromEditor(remoteEditor);
    setRemoteEditor(null);
    review({ kind: "remote", action });
  };
  const submitTag = (event: FormEvent) => {
    event.preventDefault();
    if (!tagEditor) return;
    const action: GitTagAction = {
      type: "create",
      name: tagEditor.name.trim(),
      target: tagEditor.target.trim() || null,
      annotated: tagEditor.annotated,
      message: tagEditor.annotated ? tagEditor.message.trim() : null,
    };
    setTagEditor(null);
    review({ kind: "tag", action });
  };
  const shownTags = useMemo(
    () => filterRepositoryTags(tags.data?.tags ?? [], search),
    [search, tags.data?.tags],
  );
  const currentPreview =
    reviewed?.kind === "remote" ? previewRemote : previewTag;
  const busy =
    previewRemote.isPending || previewTag.isPending || apply.isPending;

  return (
    <aside className="absolute inset-y-0 right-0 z-20 flex w-full min-w-0 flex-col border-l bg-background shadow-2xl md:w-[min(54rem,82vw)]">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <Server className="size-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Repository</p>
          <p className="truncate text-[10px] text-muted-foreground">
            Remotes, submodules, LFS, tags, signatures, and releases
          </p>
        </div>
        <Button
          size="icon"
          variant="ghost"
          className="size-8"
          onClick={onClose}
        >
          <X className="size-4" />
          <span className="sr-only">Close repository</span>
        </Button>
      </div>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <div className="flex rounded-md bg-muted/50 p-px">
          {(["remotes", "submodules", "lfs", "tags", "releases"] as const).map(
            (candidate) => (
              <button
                key={candidate}
                type="button"
                disabled={candidate === "releases" && !githubEnabled}
                className={cn(
                  "h-7 rounded px-3 text-xs capitalize text-muted-foreground disabled:opacity-40",
                  candidate === section &&
                    "bg-background font-medium text-foreground shadow-sm",
                )}
                onClick={() => setSection(candidate)}
              >
                {candidate}
              </button>
            ),
          )}
        </div>
        {section === "tags" ? (
          <label className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2 size-3 text-muted-foreground" />
            <Input
              aria-label="Search tags"
              className="h-7 pl-8 text-xs"
              placeholder="Search tags"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
        ) : (
          <span className="flex-1" />
        )}
        {section === "remotes" ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              disabled={!remotes.data || busy}
              onClick={() =>
                setRemoteEditor({
                  type: "defaults",
                  fetchRemote:
                    remotes.data?.remotes.find(
                      ({ defaultFetch }) => defaultFetch,
                    )?.name ?? "",
                  pushRemote:
                    remotes.data?.remotes.find(({ defaultPush }) => defaultPush)
                      ?.name ?? "",
                })
              }
            >
              Defaults
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 text-xs"
              disabled={busy}
              onClick={() =>
                setRemoteEditor({
                  type: "add",
                  name: "",
                  fetchUrl: "",
                  pushUrl: "",
                })
              }
            >
              <Plus className="size-3" /> Remote
            </Button>
          </>
        ) : section === "submodules" || section === "lfs" ? (
          <span className="flex-1" />
        ) : section === "tags" ? (
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 text-xs"
            disabled={busy}
            onClick={() =>
              setTagEditor({
                name: "",
                target: "",
                annotated: true,
                message: "",
              })
            }
          >
            <Plus className="size-3" /> Tag
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 text-xs"
            disabled={createRelease.isPending}
            onClick={() =>
              setReleaseEditor(releaseDraftFromTags(tags.data?.tags ?? []))
            }
          >
            <Plus className="size-3" /> Release
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {section === "remotes" ? (
          remotes.isLoading ? (
            <ContentLoading label="Loading remotes…" />
          ) : remotes.error ? (
            <InlineAlert
              className="m-4"
              size="sm"
              tone="error"
              error={remotes.error}
              fallback="Remotes could not be loaded."
            />
          ) : remotes.data?.remotes.length ? (
            remotes.data.remotes.map((remote) => (
              <div
                key={remote.name}
                data-high-contrast-row
                className="grid min-h-12 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-3 py-1.5 hover:bg-muted/40"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-xs font-medium">
                    <span>{remote.name}</span>
                    {remote.defaultFetch ? <Pill>fetch default</Pill> : null}
                    {remote.defaultPush ? <Pill>push default</Pill> : null}
                  </div>
                  <p className="truncate font-mono text-[10px] text-muted-foreground">
                    {remote.fetchUrl}
                    {remote.pushUrl !== remote.fetchUrl
                      ? ` · push ${remote.pushUrl}`
                      : ""}
                  </p>
                </div>
                <div className="flex items-center gap-0.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-[10px]"
                    disabled={busy}
                    onClick={() =>
                      review({
                        kind: "remote",
                        action: {
                          type: "fetch",
                          remote: remote.name,
                          prune: false,
                        },
                      })
                    }
                  >
                    Fetch
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-[10px]"
                    disabled={busy}
                    onClick={() =>
                      review({
                        kind: "remote",
                        action: {
                          type: "fetch",
                          remote: remote.name,
                          prune: true,
                        },
                      })
                    }
                  >
                    Prune…
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    disabled={busy}
                    onClick={() =>
                      setRemoteEditor({
                        type: "edit",
                        remote,
                        fetchUrl: remote.fetchUrl,
                        pushUrl: remote.pushUrl,
                      })
                    }
                  >
                    <Pencil className="size-3" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7 text-destructive"
                    disabled={busy}
                    onClick={() =>
                      review({
                        kind: "remote",
                        action: { type: "remove", name: remote.name },
                      })
                    }
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </div>
              </div>
            ))
          ) : (
            <ContentEmpty description="No remotes are configured." />
          )
        ) : section === "submodules" ? (
          <GitSubmodulePanel projectId={projectId} worktreeId={worktreeId} />
        ) : section === "lfs" ? (
          <GitLfsPanel projectId={projectId} worktreeId={worktreeId} />
        ) : section === "tags" ? (
          tags.isLoading ? (
            <ContentLoading label="Loading tags…" />
          ) : tags.error ? (
            <InlineAlert
              className="m-4"
              size="sm"
              tone="error"
              error={tags.error}
              fallback="Tags could not be loaded."
            />
          ) : shownTags.length ? (
            shownTags.map((tag) => (
              <button
                key={tag.name}
                type="button"
                data-high-contrast-row
                className="grid min-h-12 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-3 py-1.5 text-left hover:bg-muted/40"
                onClick={() => setSelectedTag(tag.name)}
              >
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-xs font-medium">
                    <Tag className="size-3 text-muted-foreground" /> {tag.name}
                    <Pill>{tag.annotated ? "annotated" : "lightweight"}</Pill>
                    <Pill>{signatureLabel(tag)}</Pill>
                  </span>
                  <span className="block truncate text-[10px] text-muted-foreground">
                    {tag.subject || "No tag message"} ·{" "}
                    {tag.targetHash.slice(0, 10)}
                  </span>
                </span>
                <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  {tag.publishedRemotes.length
                    ? tag.publishedRemotes.join(", ")
                    : "local only"}
                </span>
              </button>
            ))
          ) : (
            <ContentEmpty description="No tags match this search." />
          )
        ) : releases.isLoading ? (
          <ContentLoading label="Loading releases…" />
        ) : releases.error ? (
          <InlineAlert
            className="m-4"
            size="sm"
            tone="error"
            error={releases.error}
            fallback="Releases could not be loaded."
          />
        ) : releases.data?.releases.length ? (
          releases.data.releases.map((release) => (
            <div
              key={release.id}
              data-high-contrast-row
              className="grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-3 py-2 hover:bg-muted/40"
            >
              <div className="min-w-0">
                <button
                  type="button"
                  className="flex max-w-full items-center gap-1.5 text-left text-xs font-medium hover:underline"
                  onClick={() => setSelectedReleaseId(release.id)}
                >
                  <span className="truncate">{release.name}</span>
                  <Pill>{release.tagName}</Pill>
                  {release.draft ? <Pill>draft</Pill> : null}
                  {release.prerelease ? <Pill>prerelease</Pill> : null}
                </button>
                <p className="line-clamp-1 text-[10px] text-muted-foreground">
                  {release.body || `Created by ${release.author}`}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1 px-2 text-[10px]"
                asChild
              >
                <a href={release.url} target="_blank" rel="noreferrer">
                  <ExternalLink className="size-3" /> GitHub
                </a>
              </Button>
            </div>
          ))
        ) : (
          <ContentEmpty description="No GitHub releases exist for this repository." />
        )}
      </div>

      <Dialog
        open={Boolean(remoteEditor)}
        onOpenChange={(open) => !open && setRemoteEditor(null)}
      >
        <DialogContent>
          <form onSubmit={submitRemote}>
            <DialogHeader>
              <DialogTitle>
                {remoteEditor?.type === "add"
                  ? "Add remote"
                  : remoteEditor?.type === "edit"
                    ? `Edit ${remoteEditor.remote.name}`
                    : "Default remotes"}
              </DialogTitle>
              <DialogDescription>
                Configure this repository, then review the exact Git action.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3 py-4">
              {remoteEditor?.type === "defaults" ? (
                <>
                  <SelectRemote
                    label="Default fetch remote"
                    value={remoteEditor.fetchRemote}
                    remotes={remotes.data?.remotes ?? []}
                    onChange={(fetchRemote) =>
                      setRemoteEditor({ ...remoteEditor, fetchRemote })
                    }
                  />
                  <SelectRemote
                    label="Default push remote"
                    value={remoteEditor.pushRemote}
                    remotes={remotes.data?.remotes ?? []}
                    onChange={(pushRemote) =>
                      setRemoteEditor({ ...remoteEditor, pushRemote })
                    }
                  />
                </>
              ) : remoteEditor ? (
                <>
                  {remoteEditor.type === "add" ? (
                    <Input
                      autoFocus
                      placeholder="Remote name (for example, origin)"
                      value={remoteEditor.name}
                      onChange={(event) =>
                        setRemoteEditor({
                          ...remoteEditor,
                          name: event.target.value,
                        })
                      }
                    />
                  ) : null}
                  <Input
                    autoFocus={remoteEditor.type === "edit"}
                    placeholder="Fetch URL"
                    value={remoteEditor.fetchUrl}
                    onChange={(event) =>
                      setRemoteEditor({
                        ...remoteEditor,
                        fetchUrl: event.target.value,
                      })
                    }
                  />
                  <Input
                    placeholder="Push URL (defaults to fetch URL)"
                    value={remoteEditor.pushUrl}
                    onChange={(event) =>
                      setRemoteEditor({
                        ...remoteEditor,
                        pushUrl: event.target.value,
                      })
                    }
                  />
                </>
              ) : null}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setRemoteEditor(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  !remoteEditor ||
                  (remoteEditor.type === "add" &&
                    (!remoteEditor.name.trim() ||
                      !remoteEditor.fetchUrl.trim())) ||
                  (remoteEditor.type === "edit" &&
                    !remoteEditor.fetchUrl.trim())
                }
              >
                Review action
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(tagEditor)}
        onOpenChange={(open) => !open && setTagEditor(null)}
      >
        <DialogContent>
          <form onSubmit={submitTag}>
            <DialogHeader>
              <DialogTitle>Create tag</DialogTitle>
              <DialogDescription>
                Create a lightweight pointer or an annotated tag with a message.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3 py-4">
              <Input
                autoFocus
                placeholder="v1.0.0"
                value={tagEditor?.name ?? ""}
                onChange={(event) =>
                  tagEditor &&
                  setTagEditor({ ...tagEditor, name: event.target.value })
                }
              />
              <Input
                placeholder="Target revision (defaults to HEAD)"
                value={tagEditor?.target ?? ""}
                onChange={(event) =>
                  tagEditor &&
                  setTagEditor({ ...tagEditor, target: event.target.value })
                }
              />
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={tagEditor?.annotated ?? false}
                  onChange={(event) =>
                    tagEditor &&
                    setTagEditor({
                      ...tagEditor,
                      annotated: event.target.checked,
                    })
                  }
                />
                Annotated tag
              </label>
              {tagEditor?.annotated ? (
                <textarea
                  className="min-h-28 rounded-md border bg-background p-3 text-sm"
                  placeholder="Tag message"
                  value={tagEditor.message}
                  onChange={(event) =>
                    setTagEditor({ ...tagEditor, message: event.target.value })
                  }
                />
              ) : null}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setTagEditor(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  !tagEditor?.name.trim() ||
                  (tagEditor.annotated && !tagEditor.message.trim())
                }
              >
                Review action
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(selectedTag)}
        onOpenChange={(open) => !open && setSelectedTag(null)}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{selectedTag}</DialogTitle>
            <DialogDescription>
              Tag target, annotation, signature, and publication state.
            </DialogDescription>
          </DialogHeader>
          {tagDetail.isLoading ? (
            <ContentLoading className="min-h-36" label="Loading tag details…" />
          ) : tagDetail.error ? (
            <InlineAlert
              size="sm"
              tone="error"
              error={tagDetail.error}
              fallback="Tag details could not be loaded."
            />
          ) : tagDetail.data ? (
            <div className="grid gap-3 text-xs">
              <div className="rounded-lg bg-muted/30 p-3">
                <p className="font-mono text-muted-foreground">
                  {tagDetail.data.targetHash}
                </p>
                <p className="mt-2 whitespace-pre-wrap">
                  {tagDetail.data.message || "Lightweight tag"}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Pill>{signatureLabel(tagDetail.data)}</Pill>
                {tagDetail.data.signature.signer ? (
                  <Pill>{tagDetail.data.signature.signer}</Pill>
                ) : null}
                {tagDetail.data.signature.key ? (
                  <Pill>key {tagDetail.data.signature.key}</Pill>
                ) : null}
                {tagDetail.data.signature.verification !== "available" &&
                tagDetail.data.signature.verification !== "not-applicable" ? (
                  <Pill>{tagDetail.data.signature.verification}</Pill>
                ) : null}
              </div>
              {tagDetail.data.signature.fingerprint ? (
                <p className="break-all font-mono text-muted-foreground">
                  Fingerprint {tagDetail.data.signature.fingerprint}
                </p>
              ) : null}
              {tagDetail.data.signature.verificationMessage ? (
                <p className="whitespace-pre-wrap rounded-md bg-muted/35 px-3 py-2 font-mono text-[10px] text-muted-foreground">
                  {tagDetail.data.signature.verificationMessage}
                </p>
              ) : null}
            </div>
          ) : null}
          <DialogFooter className="flex-wrap">
            {(remotes.data?.remotes ?? []).map((remote) =>
              tagDetail.data?.publishedRemotes.includes(remote.name) ? (
                <Button
                  key={`delete-${remote.name}`}
                  variant="destructive"
                  disabled={busy}
                  onClick={() => {
                    setSelectedTag(null);
                    review({
                      kind: "tag",
                      action: {
                        type: "deleteRemote",
                        name: selectedTag!,
                        remote: remote.name,
                      },
                    });
                  }}
                >
                  Delete from {remote.name}
                </Button>
              ) : (
                <Button
                  key={`push-${remote.name}`}
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setSelectedTag(null);
                    review({
                      kind: "tag",
                      action: {
                        type: "push",
                        name: selectedTag!,
                        remote: remote.name,
                      },
                    });
                  }}
                >
                  Push to {remote.name}
                </Button>
              ),
            )}
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                setSelectedTag(null);
                review({
                  kind: "tag",
                  action: { type: "deleteLocal", name: selectedTag! },
                });
              }}
            >
              Delete local
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={selectedReleaseId !== null}
        onOpenChange={(open) => !open && setSelectedReleaseId(null)}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {releaseDetail.data?.name ?? "GitHub release"}
            </DialogTitle>
            <DialogDescription>
              {releaseDetail.data
                ? `${releaseDetail.data.tagName} · ${releaseDetail.data.author}`
                : "Loading release details…"}
            </DialogDescription>
          </DialogHeader>
          {releaseDetail.isLoading ? (
            <ContentLoading
              className="min-h-36"
              label="Loading release details…"
            />
          ) : releaseDetail.error ? (
            <InlineAlert
              size="sm"
              tone="error"
              error={releaseDetail.error}
              fallback="Release details could not be loaded."
            />
          ) : releaseDetail.data ? (
            <div className="max-h-[60vh] overflow-auto rounded-lg bg-muted/30 p-4 text-sm">
              <pre className="whitespace-pre-wrap font-sans">
                {releaseDetail.data.body || "No release notes."}
              </pre>
            </div>
          ) : null}
          <DialogFooter>
            {releaseDetail.data ? (
              <Button variant="outline" asChild>
                <a
                  href={releaseDetail.data.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink className="size-4" /> Open in GitHub
                </a>
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(releaseEditor)}
        onOpenChange={(open) => !open && setReleaseEditor(null)}
      >
        <DialogContent className="max-w-2xl">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (releaseEditor) createRelease.mutate(releaseEditor);
            }}
          >
            <DialogHeader>
              <DialogTitle>Create GitHub release</DialogTitle>
              <DialogDescription>
                Use an existing local tag, or enter a new tag name to release
                the selected worktree&apos;s current HEAD.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3 py-4">
              <Input
                aria-label="Release tag"
                list={releaseTagOptionsId}
                placeholder="Tag name, for example v1.0.0"
                value={releaseEditor?.tagName ?? ""}
                onChange={(event) =>
                  releaseEditor &&
                  setReleaseEditor({
                    ...releaseEditor,
                    tagName: event.target.value,
                  })
                }
              />
              <datalist id={releaseTagOptionsId}>
                {tags.data?.tags.map((tag) => (
                  <option key={tag.name} value={tag.name} />
                ))}
              </datalist>
              <Input
                placeholder="Release title"
                value={releaseEditor?.name ?? ""}
                onChange={(event) =>
                  releaseEditor &&
                  setReleaseEditor({
                    ...releaseEditor,
                    name: event.target.value,
                  })
                }
              />
              <textarea
                className="min-h-48 rounded-md border bg-background p-3 text-sm"
                placeholder="Markdown release notes"
                value={releaseEditor?.body ?? ""}
                onChange={(event) =>
                  releaseEditor &&
                  setReleaseEditor({
                    ...releaseEditor,
                    body: event.target.value,
                  })
                }
              />
              <div className="flex gap-5">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={releaseEditor?.draft ?? false}
                    onChange={(event) =>
                      releaseEditor &&
                      setReleaseEditor({
                        ...releaseEditor,
                        draft: event.target.checked,
                      })
                    }
                  />{" "}
                  Draft
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={releaseEditor?.prerelease ?? false}
                    onChange={(event) =>
                      releaseEditor &&
                      setReleaseEditor({
                        ...releaseEditor,
                        prerelease: event.target.checked,
                      })
                    }
                  />{" "}
                  Prerelease
                </label>
              </div>
              {createRelease.error ? (
                <InlineAlert
                  size="sm"
                  tone="error"
                  error={createRelease.error}
                  fallback="Release could not be created."
                />
              ) : null}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={createRelease.isPending}
                onClick={() => setReleaseEditor(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  !releaseEditor?.tagName ||
                  !releaseEditor.name.trim() ||
                  createRelease.isPending
                }
              >
                {createRelease.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : null}{" "}
                Create release
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(reviewed)}
        onOpenChange={(open) => !open && !apply.isPending && setReviewed(null)}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Confirm repository action</DialogTitle>
            <DialogDescription>
              {reviewed?.kind === "remote"
                ? remoteActionDescription(reviewed.action)
                : reviewed
                  ? `Run ${reviewed.action.type} for tag ${reviewed.action.name}.`
                  : "Review this action."}
            </DialogDescription>
          </DialogHeader>
          {currentPreview.isPending ? (
            <ContentLoading
              className="min-h-36"
              label="Preparing action preview…"
            />
          ) : currentPreview.error ? (
            <InlineAlert
              size="sm"
              tone="error"
              error={currentPreview.error}
              fallback="Action preview failed."
            />
          ) : currentPreview.data ? (
            <div className="space-y-2 rounded-lg bg-muted/30 p-3 text-xs">
              <p className="font-medium">{currentPreview.data.summary}</p>
              {currentPreview.data.warnings.map((warning) => (
                <p key={warning} className="text-amber-700 dark:text-amber-300">
                  {warning}
                </p>
              ))}
            </div>
          ) : null}
          {apply.error ? (
            <InlineAlert
              size="sm"
              tone="error"
              error={apply.error}
              fallback="Repository action failed."
            />
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={apply.isPending}
              onClick={() => setReviewed(null)}
            >
              Cancel
            </Button>
            <Button
              disabled={!currentPreview.data || apply.isPending}
              variant={
                currentPreview.data?.destructive ? "destructive" : "default"
              }
              onClick={() => apply.mutate()}
            >
              {apply.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : null}{" "}
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}

function Pill({ children }: { children: ReactNode }) {
  return (
    <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] font-normal text-muted-foreground">
      {children}
    </span>
  );
}

function SelectRemote({
  label,
  onChange,
  remotes,
  value,
}: {
  label: string;
  onChange(value: string): void;
  remotes: GitRemoteSummary[];
  value: string;
}) {
  return (
    <label className="grid gap-1 text-xs text-muted-foreground">
      {label}
      <NativeSelect
        className="h-9 rounded-md border bg-background px-3 text-sm text-foreground"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Git default</option>
        {remotes.map((remote) => (
          <option key={remote.name}>{remote.name}</option>
        ))}
      </NativeSelect>
    </label>
  );
}
