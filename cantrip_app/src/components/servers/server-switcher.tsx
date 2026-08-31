import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { CANTRIP_VERSION } from "@cantrip/version";
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
import { useEffect, useMemo, useState } from "react";

import { MobileSignInQrDialog } from "@/components/auth/mobile-sign-in-qr-dialog";
import { AddServerForm } from "@/components/servers/add-server-form";
import { ActiveServerTrafficSubmenu } from "@/components/servers/server-live-traffic";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { getServerBootstrap, logout, logoutAll } from "@/lib/api";
import { clientLogger } from "@/lib/client-log-relay";
import { clearClientSession, getClientSession } from "@/lib/client-session";
import {
  forgetActiveServerAccount,
  getActiveServerConnection,
  getServerConnections,
  removeServerConnection,
  selectServerConnection,
  testServerConnection,
} from "@/lib/server-connections";
import { cn } from "@/lib/utils";

type ServerSwitcherProps = {
  currentUserName: string;
  onOpenAdmin?(): void;
  workerName: string;
};

const itemClass =
  "flex cursor-default select-none items-center gap-2 rounded-md px-2 py-2 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground";

export type ServerVersionCompatibility =
  "loading" | "matching" | "mismatched" | "unavailable";

export function serverVersionCompatibility(
  serverVersion: string | null | undefined,
  clientVersion = CANTRIP_VERSION,
): ServerVersionCompatibility {
  if (serverVersion === undefined) return "loading";
  if (serverVersion === null) return "unavailable";
  return serverVersion === clientVersion ? "matching" : "mismatched";
}

export function ServerVersionBadge({
  clientVersion = CANTRIP_VERSION,
  serverVersion,
}: {
  clientVersion?: string;
  serverVersion: string | null | undefined;
}) {
  const compatibility = serverVersionCompatibility(
    serverVersion,
    clientVersion,
  );
  const label =
    serverVersion === undefined
      ? "Checking…"
      : serverVersion === null
        ? "Version unavailable"
        : `v${serverVersion}`;
  const title =
    compatibility === "matching"
      ? `Server ${label} matches this app.`
      : compatibility === "mismatched"
        ? `Server ${label} differs from this app (v${clientVersion}).`
        : compatibility === "loading"
          ? "Checking the server version."
          : `Server version unavailable. This app is v${clientVersion}.`;

  return (
    <span
      aria-label={title}
      className={cn(
        "shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] leading-none",
        compatibility === "matching" &&
          "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
        compatibility === "mismatched" &&
          "bg-orange-500/10 text-orange-600 dark:text-orange-400",
        (compatibility === "loading" || compatibility === "unavailable") &&
          "bg-muted text-muted-foreground",
      )}
      data-version-compatibility={compatibility}
      title={title}
    >
      {label}
    </span>
  );
}

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
  const [menuOpen, setMenuOpen] = useState(false);
  const [serverVersions, setServerVersions] = useState<
    Record<string, string | null>
  >({});
  const clientSession = getClientSession();

  useEffect(() => {
    if (!menuOpen) return;
    const unresolved = connections.filter(
      ({ id }) => !Object.hasOwn(serverVersions, id),
    );
    if (!unresolved.length) return;
    let cancelled = false;
    void Promise.all(
      unresolved.map(async (connection) => {
        try {
          const bootstrap = connection.url
            ? await testServerConnection(connection.url)
            : connection.id === active?.id
              ? await getServerBootstrap()
              : null;
          return [
            connection.id,
            bootstrap?.server.version.version ?? null,
          ] as const;
        } catch {
          return [connection.id, null] as const;
        }
      }),
    ).then((versions) => {
      if (cancelled) return;
      setServerVersions((current) => ({
        ...current,
        ...Object.fromEntries(versions),
      }));
    });
    return () => {
      cancelled = true;
    };
  }, [active?.id, connections, menuOpen, serverVersions]);

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
      await forgetActiveServerAccount();
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
      <DropdownMenuPrimitive.Root onOpenChange={setMenuOpen}>
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
            className="z-[80] min-w-72 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg"
            side="top"
            sideOffset={6}
          >
            <DropdownMenuPrimitive.Label className="px-2 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Servers
            </DropdownMenuPrimitive.Label>
            {connections.map((connection) => {
              const row = (
                <>
                  <Server className="size-4 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="block min-w-0 flex-1 truncate">
                        {connection.name}
                      </span>
                      <ServerVersionBadge
                        serverVersion={serverVersions[connection.id]}
                      />
                    </span>
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
                </>
              );
              return connection.id === active?.id ? (
                <ActiveServerTrafficSubmenu
                  className={itemClass}
                  key={connection.id}
                  serverId={connection.id}
                >
                  {row}
                </ActiveServerTrafficSubmenu>
              ) : (
                <DropdownMenuPrimitive.Item
                  className={itemClass}
                  key={connection.id}
                  onSelect={() => void switchTo(connection.id)}
                >
                  {row}
                </DropdownMenuPrimitive.Item>
              );
            })}
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
