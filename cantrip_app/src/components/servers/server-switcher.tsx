import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import {
  Check,
  Loader2,
  LogOut,
  Plus,
  QrCode,
  Server,
  ShieldOff,
  Trash2,
} from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { MobileSignInQrDialog } from "@/components/auth/mobile-sign-in-qr-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { logout, logoutAll } from "@/lib/api";
import { clearClientSession, getClientSession } from "@/lib/client-session";
import {
  getActiveServerConnection,
  getServerConnections,
  removeServerConnection,
  saveServerConnection,
  selectServerConnection,
  testServerConnection,
} from "@/lib/server-connections";

type ServerSwitcherProps = {
  currentUserName: string;
  workerName: string;
};

const itemClass =
  "flex cursor-default select-none items-center gap-2 rounded-md px-2 py-2 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground";

export function ServerSwitcher({
  currentUserName,
  workerName,
}: ServerSwitcherProps) {
  const connections = useMemo(() => [...getServerConnections()], []);
  const active = getActiveServerConnection();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [mobileQrOpen, setMobileQrOpen] = useState(false);
  const clientSession = getClientSession();

  const switchTo = (id: string) => {
    if (id === active.id) return;
    clearClientSession();
    selectServerConnection(id);
    window.location.reload();
  };

  const test = async () => {
    setTesting(true);
    setError(null);
    setTestResult(null);
    try {
      const bootstrap = await testServerConnection(url);
      setTestResult(
        `Connected to ${bootstrap.server.id} · ${
          bootstrap.auth.state === "authenticated"
            ? "ready"
            : bootstrap.auth.mode === "password"
              ? "password required"
              : "sign-in required"
        }`,
      );
    } catch (connectionError) {
      setError(
        connectionError instanceof Error
          ? connectionError.message
          : "Could not connect to that server.",
      );
    } finally {
      setTesting(false);
    }
  };

  const signOut = async (everywhere: boolean) => {
    if (signingOut) return;
    setSigningOut(true);
    setError(null);
    try {
      if (everywhere) await logoutAll();
      else await logout();
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

  const save = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      const connection = saveServerConnection({ name, url });
      clearClientSession();
      selectServerConnection(connection.id);
      window.location.reload();
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Could not save server.",
      );
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
                {active.name} · {workerName}
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
                onSelect={() => switchTo(connection.id)}
              >
                <Server className="size-4 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{connection.name}</span>
                  <span className="block truncate text-[10px] text-muted-foreground">
                    {connection.url || "Development proxy"}
                  </span>
                </span>
                {connection.id === active.id ? (
                  <Check className="size-4" />
                ) : null}
                {connection.kind === "remote" ? (
                  <button
                    aria-label={`Remove ${connection.name}`}
                    className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                    onClick={(event) => {
                      event.stopPropagation();
                      clearClientSession();
                      removeServerConnection(connection.id);
                      window.location.reload();
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
                setTestResult(null);
                setDialogOpen(true);
              }}
            >
              <Plus className="size-4" /> Add server
            </DropdownMenuPrimitive.Item>
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
          <form className="grid gap-5" onSubmit={save}>
            <DialogHeader>
              <DialogTitle>Add server</DialogTitle>
              <DialogDescription>
                Save another Cantrip Server for this app installation. Only its
                name and origin are stored; sign-in remains in the server's
                secure session cookie.
              </DialogDescription>
            </DialogHeader>
            <label className="grid gap-2 text-sm">
              Name
              <Input
                autoFocus
                onChange={(event) => setName(event.target.value)}
                placeholder="Home server"
                value={name}
              />
            </label>
            <label className="grid gap-2 text-sm">
              Server URL
              <Input
                inputMode="url"
                onChange={(event) => {
                  setUrl(event.target.value);
                  setError(null);
                  setTestResult(null);
                }}
                placeholder="https://cantrip.example"
                value={url}
              />
            </label>
            {testResult ? (
              <p className="text-sm text-emerald-500">{testResult}</p>
            ) : null}
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <DialogFooter>
              <Button
                disabled={testing}
                onClick={() => void test()}
                type="button"
                variant="outline"
              >
                {testing ? <Loader2 className="size-4 animate-spin" /> : null}
                Test connection
              </Button>
              <Button type="submit">Save and switch</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <MobileSignInQrDialog
        onOpenChange={setMobileQrOpen}
        open={mobileQrOpen}
      />
    </>
  );
}
