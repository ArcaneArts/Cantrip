import type { AccountAdminSummary } from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Gauge,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
import { useState, type FormEvent } from "react";

import { SettingsTabBar } from "@/components/settings/settings-controls";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  addAccountLicenseWhitelistEntry,
  getAccountAdminSummary,
  removeAccountLicenseWhitelistEntry,
} from "@/lib/api";
import { errorMessage } from "@/lib/error-message";

export type ServerAdminSection = "overview" | "access";

const adminTabs = [
  { id: "overview", label: "Overview", icon: Gauge },
  { id: "access", label: "Signup access", icon: ShieldCheck },
] as const;

function SummaryRow({
  description,
  icon: Icon,
  label,
  value,
}: {
  description: string;
  icon: typeof Users;
  label: string;
  value: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{label}</h2>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      <strong className="max-w-full truncate text-sm font-medium">
        {value}
      </strong>
    </div>
  );
}

export function ServerAdminPage({
  initialSection = "overview",
}: {
  initialSection?: ServerAdminSection;
}) {
  const [section, setSection] = useState<ServerAdminSection>(initialSection);
  const [email, setEmail] = useState("");
  const queryClient = useQueryClient();
  const summary = useQuery({
    queryFn: getAccountAdminSummary,
    queryKey: ["account-admin-summary"],
  });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["account-admin-summary"] });
  const addLicense = useMutation({
    mutationFn: addAccountLicenseWhitelistEntry,
    onSuccess: async () => {
      setEmail("");
      await refresh();
    },
  });
  const removeLicense = useMutation({
    mutationFn: removeAccountLicenseWhitelistEntry,
    onSuccess: refresh,
  });
  const currentError = summary.error ?? addLicense.error ?? removeLicense.error;

  const add = (event: FormEvent) => {
    event.preventDefault();
    const normalized = email.trim();
    if (!normalized || addLicense.isPending) return;
    addLicense.mutate(normalized);
  };

  const remove = (entryId: string, entryEmail: string) => {
    if (
      removeLicense.isPending ||
      !window.confirm(
        `Remove ${entryEmail} from the signup whitelist? Existing accounts are not deleted.`,
      )
    ) {
      return;
    }
    removeLicense.mutate(entryId);
  };

  return (
    <div className="flex min-h-0 min-w-0 max-w-full flex-1 flex-col overflow-hidden">
      <SettingsTabBar<ServerAdminSection>
        activeTab={section}
        ariaLabel="Server administration sections"
        tabs={adminTabs}
        onTabChange={setSection}
      />

      <div className="min-h-0 min-w-0 max-w-full flex-1 overflow-x-hidden overflow-y-auto p-4 sm:p-6">
        <div className="mx-auto grid w-full min-w-0 max-w-6xl gap-4">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div>
              <h1 className="text-base font-semibold">
                {section === "overview" ? "Server overview" : "Signup access"}
              </h1>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {section === "overview"
                  ? "Account and registration status for this Cantrip Server."
                  : "Manage which email addresses may create an account on this server."}
              </p>
            </div>
            <Button
              aria-label="Refresh server administration"
              className="size-8 shrink-0"
              disabled={summary.isFetching}
              onClick={() => void summary.refetch()}
              size="icon"
              type="button"
              variant="ghost"
            >
              <RefreshCw
                className={`size-4 ${summary.isFetching ? "animate-spin" : ""}`}
              />
            </Button>
          </div>

          {summary.isLoading ? (
            <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading server
              administration…
            </div>
          ) : summary.data ? (
            section === "overview" ? (
              <div className="min-w-0 divide-y overflow-hidden border-y">
                <SummaryRow
                  description="Accounts currently registered on this server."
                  icon={Users}
                  label="Users"
                  value={summary.data.userCount.toLocaleString()}
                />
                <SummaryRow
                  description="Controls whether an email needs an administrator-issued license before signup."
                  icon={ShieldCheck}
                  label="Signup whitelist"
                  value={
                    summary.data.licenseWhitelist.enabled
                      ? "Enforced"
                      : "Disabled"
                  }
                />
                <SummaryRow
                  description="This identity is licensed automatically and bootstraps server administration."
                  icon={CheckCircle2}
                  label="Administrator email"
                  value={
                    summary.data.licenseWhitelist.adminEmail ?? "Not configured"
                  }
                />
              </div>
            ) : (
              <AccessSection
                addPending={addLicense.isPending}
                email={email}
                onAdd={add}
                onEmailChange={setEmail}
                onRemove={remove}
                removePendingId={
                  removeLicense.isPending ? removeLicense.variables : null
                }
                summary={summary.data}
              />
            )
          ) : null}

          {currentError ? (
            <p className="text-sm text-destructive">
              {errorMessage(currentError)}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function AccessSection({
  addPending,
  email,
  onAdd,
  onEmailChange,
  onRemove,
  removePendingId,
  summary,
}: {
  addPending: boolean;
  email: string;
  onAdd(event: FormEvent): void;
  onEmailChange(value: string): void;
  onRemove(entryId: string, email: string): void;
  removePendingId: string | null;
  summary: AccountAdminSummary;
}) {
  return (
    <div className="grid min-w-0 gap-4">
      <form
        className="flex min-w-0 flex-col gap-2 border-y px-3 py-3 sm:flex-row sm:items-center"
        onSubmit={onAdd}
      >
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">License an email</h2>
          <p className="text-xs text-muted-foreground">
            The configured administrator is licensed automatically.
          </p>
        </div>
        <div className="flex min-w-0 gap-2 sm:w-[28rem]">
          <Input
            aria-label="Email to whitelist"
            autoComplete="email"
            className="min-w-0 flex-1"
            inputMode="email"
            onChange={(event) => onEmailChange(event.target.value)}
            placeholder="person@example.com"
            required
            type="email"
            value={email}
          />
          <Button disabled={addPending} type="submit">
            {addPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <UserPlus className="size-4" />
            )}
            Add
          </Button>
        </div>
      </form>

      <div className="min-w-0 overflow-hidden border-y">
        <div className="grid grid-cols-[minmax(0,1fr)_auto_2.5rem] items-center gap-3 px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          <span>Email</span>
          <span>Status</span>
          <span className="sr-only">Actions</span>
        </div>
        {summary.licenseWhitelist.entries.length ? (
          summary.licenseWhitelist.entries.map((entry) => (
            <div
              className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_2.5rem] items-center gap-3 px-3 py-2 even:bg-muted/25"
              key={entry.id}
            >
              <span className="min-w-0 truncate text-sm">{entry.email}</span>
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
                disabled={removePendingId !== null}
                onClick={() => onRemove(entry.id, entry.email)}
                size="icon"
                type="button"
                variant="ghost"
              >
                {removePendingId === entry.id ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Trash2 className="size-4" />
                )}
              </Button>
            </div>
          ))
        ) : (
          <p className="px-3 py-12 text-center text-sm text-muted-foreground">
            No additional emails are licensed yet.
          </p>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Removing a license prevents a new signup but does not delete an account
        that already exists.
      </p>
    </div>
  );
}
