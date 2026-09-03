import type { ProjectSummary } from "@cantrip/protocol";
import { Loader2, Trash2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { projectRemovalAction } from "@/lib/project-removal";

export function ProjectRemovalDialog({
  onOpenChange,
  onRemove,
  project,
}: {
  onOpenChange(open: boolean): void;
  onRemove(projectId: string, deleteLocalFiles: boolean): Promise<void>;
  project: ProjectSummary | null;
}) {
  const [deleteLocalFiles, setDeleteLocalFiles] = useState(false);
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    if (pending) return;
    setDeleteLocalFiles(false);
    setDeleteConfirmationOpen(false);
    setError(null);
    onOpenChange(false);
  };
  const submit = async (deleteFiles: boolean) => {
    if (!project || pending) return;
    setPending(true);
    setError(null);
    try {
      await onRemove(project.id, deleteFiles);
      setDeleteLocalFiles(false);
      setDeleteConfirmationOpen(false);
      onOpenChange(false);
    } catch (removeError) {
      setError(
        removeError instanceof Error
          ? removeError.message
          : "Could not remove the project.",
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <Dialog
        open={Boolean(project) && !deleteConfirmationOpen}
        onOpenChange={(open) => {
          if (!open && !deleteConfirmationOpen) close();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove project?</DialogTitle>
            <DialogDescription>
              “{project?.name}” will be unlinked from Cantrip.{" "}
              {project?.folderManagement === "external"
                ? "The attached folder remains unchanged on its worker and can be added again later."
                : project?.originKind === "managed-folder"
                  ? "The folder remains on its worker and can be added again later using its path."
                  : "Its repository remains on the worker and can be re-linked later."}
            </DialogDescription>
          </DialogHeader>
          {project?.source ? (
            <code className="block break-all rounded-md bg-muted px-3 py-2 text-xs">
              {project.source.displayPath}
            </code>
          ) : null}
          {project?.source && project.folderManagement !== "external" ? (
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border bg-muted/30 p-3 text-sm">
              <input
                checked={deleteLocalFiles}
                className="mt-0.5 size-4 accent-destructive"
                onChange={(event) => setDeleteLocalFiles(event.target.checked)}
                type="checkbox"
              />
              <span>
                <span className="font-medium">Also delete local files</span>
                <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                  Permanently removes the local project files from the worker.
                  The owning worker must be online.
                </span>
              </span>
            </label>
          ) : null}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button disabled={pending} onClick={close} variant="outline">
              Cancel
            </Button>
            <Button
              disabled={pending}
              onClick={() => {
                const action = projectRemovalAction(
                  deleteLocalFiles,
                  project?.originKind === "managed-folder",
                );
                if (action === "confirm-delete") {
                  setDeleteConfirmationOpen(true);
                } else {
                  void submit(action === "delete");
                }
              }}
              variant={deleteLocalFiles ? "destructive" : "default"}
            >
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              {deleteLocalFiles
                ? project?.originKind === "managed-folder"
                  ? "Continue to delete"
                  : "Delete files and remove"
                : "Unlink project"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(project) && deleteConfirmationOpen}
        onOpenChange={(open) => {
          if (!open && deleteConfirmationOpen) close();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete local files permanently?</DialogTitle>
            <DialogDescription>
              This deletes “{project?.name}” at the exact path below and unlinks
              the project. Cantrip and Git cannot recover these files.
            </DialogDescription>
          </DialogHeader>
          <code className="block break-all rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs">
            {project?.source?.displayPath ?? "Source unavailable"}
          </code>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button
              disabled={pending}
              onClick={() => {
                setError(null);
                setDeleteConfirmationOpen(false);
              }}
              variant="outline"
            >
              Back
            </Button>
            <Button
              onClick={() => void submit(true)}
              pending={pending}
              pendingLabel="Deleting…"
              variant="destructive"
            >
              <Trash2 className="size-4" />
              Delete folder permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
