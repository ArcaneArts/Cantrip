import { useState } from "react";
import type { RunConfigurationRepositoryEntry } from "@cantrip/protocol/run-configuration-definitions";
import { RunConfigurationEditor } from "./run-configuration-editor";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { RunDefinitionSourceProvider } from "@/lib/run-definition-source";
import {
  parseRunConfigurationCatalogKey,
  type RunConfigurationCatalog,
} from "@/lib/run-configuration-catalog";

export function RunConfigurationCatalogEditor({
  catalogs,
  configurationKey,
  projectId,
  onClose,
  onSaved,
}: {
  catalogs: readonly RunConfigurationCatalog[];
  configurationKey: string;
  projectId: string;
  onClose(): void;
  onSaved(
    catalog: RunConfigurationCatalog,
    entry: RunConfigurationRepositoryEntry,
  ): void;
}) {
  const creating = configurationKey === "new";
  const [destination, setDestination] = useState<string | null>(null);
  const identity = creating
    ? null
    : parseRunConfigurationCatalogKey(configurationKey);
  const sourceKey = creating
    ? (destination ?? (catalogs.length === 1 ? catalogs[0]!.key : null))
    : identity?.sourceKey;
  const catalog = catalogs.find((candidate) => candidate.key === sourceKey);
  if (creating && !sourceKey)
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>New Run configuration</DialogTitle>
            <DialogDescription>
              Choose where this configuration is stored and runs.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            {catalogs.map((candidate) => (
              <Button
                key={candidate.key}
                variant="outline"
                disabled={!candidate.available}
                onClick={() => setDestination(candidate.key)}
              >
                {candidate.label}
                {candidate.available ? "" : " · unavailable"}
              </Button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    );
  if (!catalog?.available)
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Run configuration unavailable</DialogTitle>
            <DialogDescription>
              Its captured destination changed or is unavailable. This
              configuration has not been moved to Host.
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    );
  return (
    <RunDefinitionSourceProvider binding={catalog.binding}>
      <RunConfigurationEditor
        creating={creating}
        destinationLabel={catalog.binding ? catalog.label : undefined}
        entry={
          creating
            ? null
            : (catalog.inventory?.entries.find(
                (entry) => entry.id === identity?.configurationId,
              ) ?? null)
        }
        open
        projectId={projectId}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        onSaved={(entry) => onSaved(catalog, entry)}
      />
    </RunDefinitionSourceProvider>
  );
}
