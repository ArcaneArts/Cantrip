import { useState } from "react";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import type { DesktopTunnelForwardSummary } from "@/lib/desktop-tunnel";

export function publicKeyWithoutComment(value: string) {
  const line = value.trim();
  return !/[\r\n]/u.test(line) && line.startsWith("ssh-ed25519 ")
    ? line.split(/\s+/u).slice(0, 2).join(" ")
    : line;
}

export function TunnelSshFields({
  service,
  publicKey,
  onChange,
}: {
  service: "tcp" | "ssh";
  publicKey: string;
  onChange(value: { service: "tcp" | "ssh"; publicKey: string }): void;
}) {
  return (
    <>
      <label className="grid gap-1.5 text-sm sm:col-span-2">
        <span className="font-medium">Linux service</span>
        <NativeSelect
          className="h-9 rounded-md border bg-background px-3"
          value={service}
          onChange={(event) =>
            onChange({
              service: event.target.value as "tcp" | "ssh",
              publicKey,
            })
          }
        >
          <option value="tcp">Development service (TCP/HTTP)</option>
          <option value="ssh">SSH / SFTP</option>
        </NativeSelect>
      </label>
      {service === "ssh" ? (
        <label className="grid gap-1.5 text-sm sm:col-span-2">
          <span className="font-medium">SSH public key</span>
          <textarea
            className="min-h-20 rounded-md border bg-background px-3 py-2 font-mono text-xs"
            required
            spellCheck={false}
            autoComplete="off"
            maxLength={1024}
            value={publicKey}
            placeholder="ssh-ed25519 AAAA…"
            onChange={(event) =>
              onChange({ service, publicKey: event.target.value })
            }
          />
          <span className="text-xs text-muted-foreground">
            Paste one Ed25519 public key from your SSH client. Its comment is
            optional. Keep the private key on your computer.
          </span>
        </label>
      ) : null}
    </>
  );
}

export function sshClientCommand(
  forward: DesktopTunnelForwardSummary,
  sftp: boolean,
  powershell: boolean,
) {
  const ssh = forward.ssh!;
  const quote = (value: string) =>
    `'${value.replaceAll("'", powershell ? "''" : "'\\''")}'`;
  return `${sftp ? "sftp" : "ssh"} -o ${quote(`UserKnownHostsFile=${ssh.knownHostsPath}`)} -o StrictHostKeyChecking=yes -o GlobalKnownHostsFile=none -o ${quote(`HostKeyAlias=${ssh.hostAlias}`)} ${sftp ? "-P" : "-p"} ${forward.localPort} ${ssh.user}@${forward.localHost}`;
}

export function TunnelSshDetails({
  forward,
  name,
}: {
  forward: DesktopTunnelForwardSummary;
  name: string;
}) {
  const [open, setOpen] = useState(false);
  if (!forward.ssh) return null;
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        aria-label={`SSH connection details for ${name}`}
        title="SSH / SFTP connection details"
        onClick={() => setOpen(true)}
      >
        <KeyRound className="size-3.5" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>SSH / SFTP · {name}</DialogTitle>
            <DialogDescription>
              Use your SSH client with the private key matching this route's
              public key. The host pin lasts for this local attachment.
            </DialogDescription>
          </DialogHeader>
          <p className="break-all font-mono text-xs">
            {forward.ssh.user} · {forward.ssh.fingerprint}
          </p>
          {[false, true].map((powershell) => (
            <div key={String(powershell)} className="space-y-2">
              <p className="text-xs text-muted-foreground">
                {powershell ? "PowerShell" : "macOS / Linux"}
              </p>
              {[false, true].map((sftp) => (
                <div
                  key={String(sftp)}
                  className="flex min-w-0 items-start gap-2"
                >
                  <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all rounded border p-2 text-xs">
                    {sshClientCommand(forward, sftp, powershell)}
                  </pre>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      void navigator.clipboard.writeText(
                        sshClientCommand(forward, sftp, powershell),
                      )
                    }
                  >
                    Copy {sftp ? "SFTP" : "SSH"}
                  </Button>
                </div>
              ))}
            </div>
          ))}
        </DialogContent>
      </Dialog>
    </>
  );
}
