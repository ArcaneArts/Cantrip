import type { RunConfigurationProviderValidation } from "@cantrip/protocol/run-configuration-definitions";
import {
  CheckCircle2,
  Loader2,
  RefreshCw,
  Search,
  TriangleAlert,
} from "lucide-react";

import { Button } from "@/components/ui/button";

function platformLabel(
  platform: RunConfigurationProviderValidation["platform"],
): string {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
  }
}

export function RunConfigurationValidationStatus({
  error,
  localErrors,
  onRediscover,
  onRetry,
  pending,
  validation,
}: {
  error: unknown;
  localErrors: string[];
  onRediscover: (() => void) | null;
  onRetry(): void;
  pending: boolean;
  validation: RunConfigurationProviderValidation | null;
}) {
  if (localErrors.length > 0) {
    return (
      <div className="grid gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
        <div className="flex items-center gap-2 font-medium text-amber-700 dark:text-amber-300">
          <TriangleAlert className="size-4 shrink-0" />
          Finish the draft to validate it on Primary
        </div>
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          {localErrors.slice(0, 5).map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      </div>
    );
  }

  if (pending) {
    return (
      <div className="flex items-center gap-2 rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Validating this draft on Primary…
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive"
        role="alert"
      >
        <div className="flex items-center gap-2">
          <TriangleAlert className="size-4 shrink-0" />
          Primary could not validate this draft. Check worker availability and
          try again.
        </div>
        <Button onClick={onRetry} size="sm" type="button" variant="outline">
          <RefreshCw className="size-3.5" /> Retry validation
        </Button>
      </div>
    );
  }

  if (!validation) return null;

  const warnings = validation.diagnostics.filter(
    ({ severity }) => severity === "warning",
  );
  if (validation.valid && warnings.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-xs text-emerald-700 dark:text-emerald-300">
        <CheckCircle2 className="size-4 shrink-0" />
        Validated on Primary for {platformLabel(validation.platform)}
      </div>
    );
  }

  return (
    <div
      className={
        validation.valid
          ? "grid gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs"
          : "grid gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs"
      }
      role={validation.valid ? "status" : "alert"}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          className={
            validation.valid
              ? "flex items-center gap-2 font-medium text-amber-700 dark:text-amber-300"
              : "flex items-center gap-2 font-medium text-destructive"
          }
        >
          <TriangleAlert className="size-4 shrink-0" />
          {validation.valid
            ? `Validated with warnings on Primary for ${platformLabel(validation.platform)}`
            : `Primary cannot run this target on ${platformLabel(validation.platform)}`}
        </div>
        {!validation.valid && onRediscover ? (
          <Button
            onClick={onRediscover}
            size="sm"
            type="button"
            variant="outline"
          >
            <Search className="size-3.5" /> Rediscover target
          </Button>
        ) : null}
      </div>
      <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
        {validation.diagnostics.map((diagnostic) => {
          const context = diagnostic.field ?? diagnostic.relativePath;
          return (
            <li
              key={`${diagnostic.code}:${context ?? ""}:${diagnostic.message}`}
            >
              {diagnostic.message}
              {context ? (
                <span className="font-mono text-[0.7rem]"> ({context})</span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
