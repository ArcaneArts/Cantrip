import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { WorkerSummary, CantripOsTransport } from "@cantrip/protocol";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { attachCantripOs, inspectCantripOs } from "@/lib/api/cantrip-os";
import { errorMessage } from "@/lib/error-message";

export function CantripOsAttachForm({
  workers,
  onAttached,
}: {
  workers: WorkerSummary[];
  onAttached(id: string): void;
}) {
  const [workerId, setWorkerId] = useState(workers[0]?.workerId ?? "");
  const [kind, setKind] = useState<"docker" | "ssh">("docker");
  const [name, setName] = useState("CantripOS");
  const [container, setContainer] = useState("cantrip-os");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("cantrip");
  const [identityFile, setIdentityFile] = useState("");
  const [knownHostsFile, setKnownHostsFile] = useState("");
  const attach = useMutation({
    mutationFn: async () => {
      const transport: CantripOsTransport =
        kind === "docker"
          ? { kind, container }
          : {
              kind,
              host,
              port: Number(port),
              user,
              identityFile,
              knownHostsFile,
            };
      const actual = await inspectCantripOs({ workerId, transport });
      return attachCantripOs({
        workerId,
        transport,
        name,
        guestInstanceId: actual.guestInstanceId,
        expectedAttachmentGeneration: null,
      });
    },
    onSuccess: (result) => onAttached(result.instance.id),
  });
  return (
    <form
      className="space-y-3 rounded-lg border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        attach.mutate();
      }}
    >
      <h3 className="font-medium">Attach CantripOS</h3>
      <p className="text-sm text-muted-foreground">
        Start the OS with <code>CANTRIP_OS_EXECUTOR=1 pnpm os</code>, then
        connect it through its existing worker.
      </p>
      <label className="block space-y-1 text-sm">
        Worker
        <NativeSelect
          className="w-full"
          value={workerId}
          onChange={(e) => setWorkerId(e.target.value)}
        >
          {workers.map((worker) => (
            <option key={worker.workerId} value={worker.workerId}>
              {worker.name}
            </option>
          ))}
        </NativeSelect>
      </label>
      <label className="block space-y-1 text-sm">
        Name
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </label>
      <label className="block space-y-1 text-sm">
        Connection
        <NativeSelect
          className="w-full"
          value={kind}
          onChange={(e) => setKind(e.target.value as typeof kind)}
        >
          <option value="docker">Docker on this worker</option>
          <option value="ssh">Installed Linux over SSH</option>
        </NativeSelect>
      </label>
      {kind === "docker" ? (
        <label className="block space-y-1 text-sm">
          Container name
          <Input
            value={container}
            onChange={(e) => setContainer(e.target.value)}
            required
          />
        </label>
      ) : (
        <>
          <label className="block space-y-1 text-sm">
            Host
            <Input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              required
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1 text-sm">
              SSH port
              <Input
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(e) => setPort(e.target.value)}
                required
              />
            </label>
            <label className="space-y-1 text-sm">
              SSH user
              <Input
                value={user}
                onChange={(e) => setUser(e.target.value)}
                required
              />
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            These key and known-host files stay on the worker. SSH uses pinned
            host verification and passwordless sudo.
          </p>
          <label className="block space-y-1 text-sm">
            Identity file on worker
            <Input
              value={identityFile}
              onChange={(e) => setIdentityFile(e.target.value)}
              required
            />
          </label>
          <label className="block space-y-1 text-sm">
            Known-hosts file on worker
            <Input
              value={knownHostsFile}
              onChange={(e) => setKnownHostsFile(e.target.value)}
              required
            />
          </label>
        </>
      )}
      {attach.error ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(attach.error)}
        </p>
      ) : null}
      <Button type="submit" disabled={attach.isPending}>
        {attach.isPending ? "Connecting…" : "Inspect and attach"}
      </Button>
    </form>
  );
}
