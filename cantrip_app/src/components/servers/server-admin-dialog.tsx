import type { AccountAdminSummary } from "@cantrip/protocol";
import {
  CheckCircle2,
  Loader2,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  addAccountLicenseWhitelistEntry,
  getAccountAdminSummary,
  removeAccountLicenseWhitelistEntry,
} from "@/lib/api";
import { errorMessage } from "@/lib/error-message";

export function ServerAdminDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const [summary, setSummary] = useState<AccountAdminSummary | null>(null);
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSummary(await getAccountAdminSummary());
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!email.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await addAccountLicenseWhitelistEntry(email);
      setEmail("");
      await refresh();
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (entryId: string, entryEmail: string) => {
    if (
      removingId ||
      !window.confirm(
        `Remove ${entryEmail} from the signup whitelist? Existing accounts are not deleted.`,
      )
    ) {
      return;
    }
    setRemovingId(entryId);
    setError(null);
    try {
      await removeAccountLicenseWhitelistEntry(entryId);
      await refresh();
    } catch (removeError) {
      setError(errorMessage(removeError));
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Server administration</DialogTitle>
          <DialogDescription>
            Manage who may create an account on this Cantrip Server. Removing a
            license does not delete an account that already exists.
          </DialogDescription>
        </DialogHeader>

        {loading && !summary ? (
          <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading server
            administration…
          </div>
        ) : summary ? (
          <div className="grid gap-5">
            <div className="grid gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-3">
              <div className="bg-background px-3 py-3">
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Users className="size-3.5" /> Users
                </span>
                <strong className="mt-1 block text-xl font-semibold">
                  {summary.userCount.toLocaleString()}
                </strong>
              </div>
              <div className="bg-background px-3 py-3">
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  <ShieldCheck className="size-3.5" /> Signup whitelist
                </span>
                <strong className="mt-1 block text-sm font-medium">
                  {summary.licenseWhitelist.enabled ? "Enforced" : "Disabled"}
                </strong>
              </div>
              <div className="min-w-0 bg-background px-3 py-3">
                <span className="text-xs text-muted-foreground">
                  Administrator email
                </span>
                <strong className="mt-1 block truncate text-sm font-medium">
                  {summary.licenseWhitelist.adminEmail ?? "Not configured"}
                </strong>
              </div>
            </div>

            <section className="grid gap-3">
              <div>
                <h3 className="text-sm font-semibold">Licensed emails</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  These email addresses may create accounts. The configured
                  administrator is licensed automatically.
                </p>
              </div>

              <form className="flex gap-2" onSubmit={add}>
                <Input
                  aria-label="Email to whitelist"
                  autoComplete="email"
                  className="min-w-0 flex-1"
                  inputMode="email"
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="person@example.com"
                  required
                  type="email"
                  value={email}
                />
                <Button disabled={saving} type="submit">
                  {saving ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <UserPlus className="size-4" />
                  )}
                  Add
                </Button>
              </form>

              <div className="max-h-72 overflow-y-auto border-y">
                {summary.licenseWhitelist.entries.length ? (
                  summary.licenseWhitelist.entries.map((entry) => (
                    <div
                      className="flex min-w-0 items-center gap-3 px-2 py-2 even:bg-muted/25"
                      key={entry.id}
                    >
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {entry.email}
                      </span>
                      {entry.registered ? (
                        <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                          <CheckCircle2 className="size-3.5" /> Registered
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          Awaiting signup
                        </span>
                      )}
                      <Button
                        aria-label={`Remove ${entry.email}`}
                        className="size-8"
                        disabled={removingId !== null}
                        onClick={() => void remove(entry.id, entry.email)}
                        size="icon"
                        type="button"
                        variant="ghost"
                      >
                        {removingId === entry.id ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Trash2 className="size-4" />
                        )}
                      </Button>
                    </div>
                  ))
                ) : (
                  <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                    No additional emails are licensed yet.
                  </p>
                )}
              </div>
            </section>
          </div>
        ) : null}

        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </DialogContent>
    </Dialog>
  );
}
