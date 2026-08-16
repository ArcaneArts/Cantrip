import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import {
  Check,
  LogOut,
  Plus,
  QrCode,
  Server,
  ShieldCheck,
  ShieldOff,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";

import { MobileSignInQrDialog } from "@/components/auth/mobile-sign-in-qr-dialog";
import { AddServerForm } from "@/components/servers/add-server-form";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { logout, logoutAll } from "@/lib/api";
import { clientLogger } from "@/lib/client-log-relay";
import { clearClientSession, getClientSession } from "@/lib/client-session";
import {
  getActiveServerConnection,
  getServerConnections,
  removeServerConnection,
  selectServerConnection,
} from "@/lib/server-connections";

type ServerSwitcherProps = {
  currentUserName: string;
  onOpenAdmin?(): void;
  workerName: string;
};

const itemClass =
  "flex cursor-default select-none items-center gap-2 rounded-md px-2 py-2 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground";

export function ServerSwitcher({
  currentUserName,
  onOpenAdmin,
  workerName,
}: ServerSwitcherProps) {
  const connections = useMemo(() => [...getServerConnections()], []);
  const active = getActiveServerConnection();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [mobileQrOpen, setMobileQrOpen] = useState(false);
  const clientSession = getClientSession();

  const switchTo = async (id: string) => {
    if (id === active?.id) return;
    setError(null);
    try {
      await selectServerConnection(id);
      clearClientSession();
      window.location.reload();
    } catch (switchError) {
      setError(
        switchError instanceof Error
          ? switchError.message
          : "Could not switch servers.",
      );
    }
  };

  const signOut = async (everywhere: boolean) => {
    if (signingOut) return;
    setSigningOut(true);
    setError(null);
    try {
      const startedAt = performance.now();
      clientLogger.info("Sign-out started", {
        event: "session.logout.started",
        operation: everywhere ? "logout-all" : "logout",
        subsystem: "authentication",
      });
      try {
        if (everywhere) await logoutAll();
        else await logout();
        clientLogger.info("Sign-out completed", {
          durationMs: Math.round(performance.now() - startedAt),
          event: "session.logout.completed",
          operation: everywhere ? "logout-all" : "logout",
          status: "signed-out",
          subsystem: "authentication",
        });
      } catch (error) {
        clientLogger.warn("Sign-out failed", {
          durationMs: Math.round(performance.now() - startedAt),
          error: error instanceof Error ? error : new Error("Sign-out failed"),
          event: "session.logout.failed",
          operation: everywhere ? "logout-all" : "logout",
          reasonCode: "request-failed",
          status: "failed",
          subsystem: "authentication",
        });
        throw error;
      }
      clearClientSession();
      window.location.reload();
    } catch (signOutError) {
      setError(
        signOutError instanceof Error
          ? signOutError.message
          : "Could not sign out.",
      );
      setSigningOut(false);
    }
  };

  return (
    <>
      <DropdownMenuPrimitive.Root>
        <DropdownMenuPrimitive.Trigger asChild>
          <button
            className="flex min-w-0 flex-1 items-center rounded-lg px-2 py-2 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
            type="button"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium">
                {currentUserName}
              </span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {active?.name ?? "No server"} · {workerName}
              </span>
            </span>
          </button>
        </DropdownMenuPrimitive.Trigger>
        <DropdownMenuPrimitive.Portal>
          <DropdownMenuPrimitive.Content
            align="start"
            className="z-[80] min-w-64 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg"
            side="top"
            sideOffset={6}
          >
            <DropdownMenuPrimitive.Label className="px-2 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Servers
            </DropdownMenuPrimitive.Label>
            {connections.map((connection) => (
              <DropdownMenuPrimitive.Item
                className={itemClass}
                key={connection.id}
                onSelect={() => void switchTo(connection.id)}
              >
                <Server className="size-4 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{connection.name}</span>
                  <span className="block truncate text-[10px] text-muted-foreground">
                    {connection.url || "Development proxy"}
                  </span>
                </span>
                {connection.id === active?.id ? (
                  <Check className="size-4" />
                ) : null}
                {connection.kind === "remote" ? (
                  <button
                    aria-label={`Remove ${connection.name}`}
                    className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                    onClick={(event) => {
                      event.stopPropagation();
                      void removeServerConnection(connection.id)
                        .then(() => {
                          clearClientSession();
                          window.location.reload();
                        })
                        .catch((removeError) =>
                          setError(
                            removeError instanceof Error
                              ? removeError.message
                              : "Could not remove server.",
                          ),
                        );
                    }}
                    type="button"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                ) : null}
              </DropdownMenuPrimitive.Item>
            ))}
            <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />
            <DropdownMenuPrimitive.Item
              className={itemClass}
              onSelect={() => {
                setError(null);
                setDialogOpen(true);
              }}
            >
              <Plus className="size-4" /> Add server
            </DropdownMenuPrimitive.Item>
            {onOpenAdmin &&
            clientSession?.authMode === "accounts" &&
            ["owner", "admin"].includes(clientSession.user.role) ? (
              <DropdownMenuPrimitive.Item
                className={itemClass}
                onSelect={onOpenAdmin}
              >
                <ShieldCheck className="size-4" /> Admin
              </DropdownMenuPrimitive.Item>
            ) : null}
            {clientSession?.authMode !== "none" ? (
              <>
                <DropdownMenuPrimitive.Item
                  className={itemClass}
                  onSelect={() => setMobileQrOpen(true)}
                >
                  <QrCode className="size-4" /> Sign in mobile device
                </DropdownMenuPrimitive.Item>
                <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />
                <DropdownMenuPrimitive.Item
                  className={itemClass}
                  disabled={signingOut}
                  onSelect={() => void signOut(false)}
                >
                  <LogOut className="size-4" /> Sign out
                </DropdownMenuPrimitive.Item>
                <DropdownMenuPrimitive.Item
                  className={`${itemClass} text-destructive`}
                  disabled={signingOut}
                  onSelect={() => void signOut(true)}
                >
                  <ShieldOff className="size-4" /> Sign out everywhere
                </DropdownMenuPrimitive.Item>
              </>
            ) : null}
            {error && !dialogOpen ? (
              <p className="max-w-64 px-2 py-1.5 text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </DropdownMenuPrimitive.Content>
        </DropdownMenuPrimitive.Portal>
      </DropdownMenuPrimitive.Root>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add server</DialogTitle>
            <DialogDescription>
              Save another Cantrip Server for this app installation. Only its
              name and origin are stored; sign-in remains in the server's secure
              session cookie.
            </DialogDescription>
          </DialogHeader>
          <AddServerForm
            autoFocus
            onSaved={async (connection) => {
              await selectServerConnection(connection.id);
              clearClientSession();
              window.location.reload();
            }}
          />
        </DialogContent>
      </Dialog>
      <MobileSignInQrDialog
        onOpenChange={setMobileQrOpen}
        open={mobileQrOpen}
      />
    </>
  );
}
