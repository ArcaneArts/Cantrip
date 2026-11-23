import { useState } from "react";
import { Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import type { DesktopTunnelForwardSummary } from "@/lib/desktop-tunnel";

export function TunnelVncDetails({
  forward,
  name,
}: {
  forward: DesktopTunnelForwardSummary;
  name: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        title="VNC connection details"
        aria-label={`VNC connection details for ${name}`}
        onClick={() => setOpen(true)}
      >
        <Monitor className="size-3.5" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>VNC · {name}</DialogTitle>
            <DialogDescription>
              Connect your VNC client to this local host and port. Cantrip
              manages access, so no VNC password is needed.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-[auto_1fr_auto] items-center gap-3 text-sm">
            <span>Host</span>
            <code>{forward.localHost}</code>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void navigator.clipboard.writeText(forward.localHost)
              }
            >
              Copy host
            </Button>
            <span>Port</span>
            <code>{forward.localPort}</code>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void navigator.clipboard.writeText(String(forward.localPort))
              }
            >
              Copy port
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            The agent pauses while your VNC client is connected. Close the
            client or stop this tunnel to return control. One controller can use
            the assigned workspace desktop at a time.
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}
