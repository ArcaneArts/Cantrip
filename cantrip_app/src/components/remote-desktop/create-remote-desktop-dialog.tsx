import type { RemoteDesktopCreate, WorkerSummary } from "@cantrip/protocol";
import { Loader2, MonitorUp } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function CreateRemoteDesktopDialog({
  defaultWorkerId,
  error,
  onOpenChange,
  onSubmit,
  open,
  pending,
  workers,
}: {
  defaultWorkerId: string | null;
  error: string | null;
  onOpenChange(open: boolean): void;
  onSubmit(input: RemoteDesktopCreate): void;
  open: boolean;
  pending: boolean;
  workers: WorkerSummary[];
}) {
  const availableWorkers = useMemo(
    () => workers.filter((worker) => worker.remoteSurfaces.vnc),
    [workers],
  );
  const [title, setTitle] = useState("Remote Desktop");
  const [workerId, setWorkerId] = useState("");
  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState("5900");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");

  useEffect(() => {
    if (!open) return;
    setWorkerId(
      availableWorkers.some((worker) => worker.workerId === defaultWorkerId)
        ? (defaultWorkerId ?? "")
        : (availableWorkers[0]?.workerId ?? ""),
    );
    setPassword("");
  }, [availableWorkers, defaultWorkerId, open]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsedPort = Number.parseInt(port, 10);
    if (!workerId || !host.trim() || !Number.isInteger(parsedPort)) return;
    onSubmit({
      title: title.trim() || "Remote Desktop",
      workerId,
      host: host.trim(),
      port: parsedPort,
      displayName: displayName.trim() || null,
      password: password || null,
    });
  };

  return (
    <Dialog open={open} onOpenChange={pending ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MonitorUp className="size-4" />
              Add Remote Desktop
            </DialogTitle>
            <DialogDescription>
              Connect through a worker to an existing VNC/RFB endpoint. The
              password is stored only on that worker.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-5 sm:grid-cols-2">
            <label className="grid gap-1.5 text-sm sm:col-span-2">
              <span className="font-medium">Title</span>
              <input
                className="h-9 rounded-md border bg-background px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                maxLength={200}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <label className="grid gap-1.5 text-sm sm:col-span-2">
              <span className="font-medium">Worker</span>
              <select
                className="h-9 rounded-md border bg-background px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={workerId}
                onChange={(event) => setWorkerId(event.target.value)}
              >
                {availableWorkers.map((worker) => (
                  <option key={worker.workerId} value={worker.workerId}>
                    {worker.name}
                    {worker.online ? "" : " (offline)"}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1.5 text-sm">
              <span className="font-medium">Host</span>
              <input
                required
                className="h-9 rounded-md border bg-background px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                maxLength={253}
                placeholder="127.0.0.1"
                value={host}
                onChange={(event) => setHost(event.target.value)}
              />
            </label>
            <label className="grid gap-1.5 text-sm">
              <span className="font-medium">Port</span>
              <input
                required
                className="h-9 rounded-md border bg-background px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                inputMode="numeric"
                max={65535}
                min={1}
                type="number"
                value={port}
                onChange={(event) => setPort(event.target.value)}
              />
            </label>
            <label className="grid gap-1.5 text-sm sm:col-span-2">
              <span className="font-medium">Display name (optional)</span>
              <input
                className="h-9 rounded-md border bg-background px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                maxLength={200}
                placeholder="Desk Mac mini"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </label>
            <label className="grid gap-1.5 text-sm sm:col-span-2">
              <span className="font-medium">VNC password (optional)</span>
              <input
                autoComplete="new-password"
                className="h-9 rounded-md border bg-background px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                maxLength={1024}
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
          </div>

          {availableWorkers.length === 0 ? (
            <p className="mb-4 text-sm text-destructive">
              No worker currently advertises Remote Desktop support.
            </p>
          ) : null}
          {error ? (
            <p className="mb-4 text-sm text-destructive">{error}</p>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={pending || availableWorkers.length === 0 || !workerId}
            >
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              Add desktop
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
