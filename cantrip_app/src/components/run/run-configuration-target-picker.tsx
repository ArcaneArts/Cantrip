import type {
  RunConfigurationDetectionCandidate,
  RunConfigurationDiagnostic,
  RunConfigurationFile,
} from "@cantrip/protocol/run-configuration-definitions";
import { Check, Loader2, RefreshCw, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { InlineAlert } from "@/components/ui/inline-alert";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { runConfigurationTargetLabel } from "@/lib/run-configuration-editor-model";

function targetMatches(
  current: RunConfigurationFile,
  candidate: RunConfigurationDetectionCandidate,
): boolean {
  return (
    current.provider === candidate.provider &&
    current.workingDirectory === candidate.document.workingDirectory &&
    JSON.stringify(current.target) === JSON.stringify(candidate.document.target)
  );
}

export function RunConfigurationTargetPickerList({
  candidates,
  current,
  diagnostics,
  error,
  fetching,
  onChoose,
}: {
  candidates: RunConfigurationDetectionCandidate[];
  current: RunConfigurationFile;
  diagnostics: RunConfigurationDiagnostic[];
  error: Error | null;
  fetching: boolean;
  onChoose(candidate: RunConfigurationDetectionCandidate): void;
}) {
  if (fetching && candidates.length === 0) {
    return (
      <div className="flex min-h-36 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Discovering targets…
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      {error ? (
        <InlineAlert className="m-2 mb-0" error={error} tone="error" />
      ) : null}
      <Command>
        <CommandInput placeholder="Search targets, commands, and paths…" />
        <CommandList className="max-h-80">
          <CommandEmpty>
            No matching {current.provider} targets were detected.
          </CommandEmpty>
          <CommandGroup>
            {candidates.map((candidate) => {
              const selected = targetMatches(current, candidate);
              return (
                <CommandItem
                  className="grid gap-1.5 border-b p-3 last:border-b-0"
                  key={candidate.document.id}
                  onSelect={() => onChoose(candidate)}
                  value={`${candidate.document.name} ${candidate.provider} ${candidate.document.workingDirectory} ${runConfigurationTargetLabel(candidate.document)} ${candidate.effectiveCommand} ${candidate.reason}`}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <Check
                      className={
                        selected
                          ? "size-4 shrink-0 text-emerald-600"
                          : "size-4 shrink-0 opacity-0"
                      }
                    />
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {runConfigurationTargetLabel(candidate.document)}
                    </span>
                    <span className="text-[10px] uppercase text-muted-foreground">
                      {candidate.confidence}
                    </span>
                  </div>
                  <div className="ml-6 grid gap-1">
                    <code className="truncate text-xs">
                      {candidate.effectiveCommand}
                    </code>
                    <span className="truncate text-xs text-muted-foreground">
                      {candidate.document.workingDirectory === "."
                        ? "Project root"
                        : candidate.document.workingDirectory}
                      {" · "}
                      {candidate.reason}
                    </span>
                  </div>
                </CommandItem>
              );
            })}
          </CommandGroup>
        </CommandList>
      </Command>
      {diagnostics.length ? (
        <InlineAlert className="m-2 mt-0" tone="warning">
          {diagnostics.map(({ message }) => message).join(" ")}
        </InlineAlert>
      ) : null}
    </div>
  );
}

export function RunConfigurationTargetPicker({
  candidates,
  current,
  diagnostics,
  error,
  fetching,
  open,
  onChoose,
  onOpenChange,
  onRefresh,
}: {
  candidates: RunConfigurationDetectionCandidate[];
  current: RunConfigurationFile;
  diagnostics: RunConfigurationDiagnostic[];
  error: Error | null;
  fetching: boolean;
  open: boolean;
  onChoose(candidate: RunConfigurationDetectionCandidate): void;
  onOpenChange(open: boolean): void;
  onRefresh(): void;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          aria-label="Browse detected Run configuration targets"
          size="sm"
          type="button"
          variant="outline"
        >
          <Search className="size-3.5" /> Browse detected targets
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[min(34rem,calc(100vw-2rem))] p-0"
      >
        <div className="flex items-start justify-between gap-3 border-b p-3">
          <div>
            <h4 className="text-sm font-medium">
              Detected {current.provider} targets
            </h4>
            <p className="text-xs text-muted-foreground">
              Static worker discovery never executes project code. Applying a
              target keeps this configuration&apos;s identity and common
              settings.
            </p>
          </div>
          <Button
            aria-label="Refresh detected Run configuration targets"
            className="size-8"
            disabled={fetching}
            onClick={onRefresh}
            size="icon"
            type="button"
            variant="ghost"
          >
            <RefreshCw className={fetching ? "animate-spin" : undefined} />
          </Button>
        </div>
        <RunConfigurationTargetPickerList
          candidates={candidates}
          current={current}
          diagnostics={diagnostics}
          error={error}
          fetching={fetching}
          onChoose={onChoose}
        />
      </PopoverContent>
    </Popover>
  );
}
