import { Loader2 } from "lucide-react";
import { useState, type FormEvent } from "react";

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

export function WorkspaceCreateDialog({
  onCreate,
  onOpenChange,
  open,
}: {
  onCreate(name: string): Promise<void>;
  onOpenChange(open: boolean): void;
  open: boolean;
}) {
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const nextName = name.trim();
    if (!nextName || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onCreate(nextName);
      setName("");
      onOpenChange(false);
    } catch (createError) {
      setError(
        createError instanceof Error
          ? createError.message
          : "Could not create the workspace.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form className="grid gap-5" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>New workspace</DialogTitle>
            <DialogDescription>
              Workspaces filter the projects shown in the sidebar. Projects can
              belong to more than one workspace.
            </DialogDescription>
          </DialogHeader>
          <label className="grid gap-2 text-sm">
            Name
            <Input
              autoFocus
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Personal Projects"
            />
          </label>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button disabled={!name.trim() || submitting} type="submit">
              {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
              Create and switch
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
