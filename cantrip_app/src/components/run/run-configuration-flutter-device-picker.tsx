import type { RunConfigurationFlutterDocument } from "@cantrip/protocol/run-configuration-definitions";
import type { RunConfigurationFlutterDevice } from "@cantrip/protocol/run-configuration-operations";
import { useQuery } from "@tanstack/react-query";
import {
  Check,
  Loader2,
  MonitorSmartphone,
  RefreshCw,
  Search,
} from "lucide-react";
import { useState } from "react";

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
import { inspectFlutterRunConfigurationDevices } from "@/lib/run-configuration-api";

export function RunConfigurationFlutterDevicePickerList({
  currentDeviceId,
  devices,
  fetched,
  fetching,
  onChoose,
}: {
  currentDeviceId: string;
  devices: RunConfigurationFlutterDevice[];
  fetched: boolean;
  fetching: boolean;
  onChoose(device: RunConfigurationFlutterDevice): void;
}) {
  if (fetching && devices.length === 0) {
    return (
      <div className="flex min-h-36 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Inspecting Flutter devices…
      </div>
    );
  }
  if (!fetched) {
    return (
      <div className="min-h-28 px-4 py-8 text-center text-sm text-muted-foreground">
        Refresh devices to inspect the Flutter targets connected to
        Primary&apos;s worker.
      </div>
    );
  }

  return (
    <Command>
      <CommandInput placeholder="Search devices, IDs, and platforms…" />
      <CommandList className="max-h-80">
        <CommandEmpty>No matching Flutter devices.</CommandEmpty>
        <CommandGroup>
          {devices.map((device) => {
            const selected = device.id === currentDeviceId;
            return (
              <CommandItem
                className="gap-3 border-b p-3 last:border-b-0"
                disabled={!device.supported}
                key={device.id}
                onSelect={() => onChoose(device)}
                value={`${device.name} ${device.id} ${device.targetPlatform ?? ""} ${device.emulator ? "emulator" : "physical"}`}
              >
                <Check
                  className={
                    selected
                      ? "size-4 shrink-0 text-emerald-600"
                      : "size-4 shrink-0 opacity-0"
                  }
                />
                <MonitorSmartphone className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {device.name}
                  </span>
                  <span className="block truncate font-mono text-xs text-muted-foreground">
                    {device.id}
                    {device.targetPlatform ? ` · ${device.targetPlatform}` : ""}
                    {device.emulator ? " · emulator" : ""}
                  </span>
                </span>
                {!device.supported ? (
                  <span className="text-xs text-muted-foreground">
                    Unsupported
                  </span>
                ) : null}
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}

export function RunConfigurationFlutterDevicePicker({
  currentDeviceId,
  document,
  onChoose,
  projectId,
}: {
  currentDeviceId: string;
  document: RunConfigurationFlutterDocument;
  onChoose(deviceId: string): void;
  projectId: string;
}) {
  const [open, setOpen] = useState(false);
  const fingerprint = JSON.stringify(document);
  const inspection = useQuery({
    enabled: false,
    queryKey: ["run-configuration-flutter-devices", projectId, fingerprint],
    queryFn: () => inspectFlutterRunConfigurationDevices(projectId, document),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          aria-label="Browse Flutter devices"
          className="shrink-0"
          size="sm"
          type="button"
          variant="outline"
        >
          <Search className="size-3.5" /> Browse devices
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[min(34rem,calc(100vw-2rem))] p-0"
      >
        <div className="flex items-start justify-between gap-3 border-b p-3">
          <div>
            <h4 className="text-sm font-medium">Flutter devices</h4>
            <p className="text-xs text-muted-foreground">
              Refresh explicitly runs a bounded Flutter device inspection on
              Primary&apos;s worker using this draft&apos;s SDK and start
              directory.
            </p>
          </div>
          <Button
            aria-label="Refresh Flutter devices"
            className="size-8 shrink-0"
            disabled={inspection.isFetching}
            onClick={() => void inspection.refetch()}
            size="icon"
            type="button"
            variant="ghost"
          >
            <RefreshCw
              className={inspection.isFetching ? "animate-spin" : undefined}
            />
          </Button>
        </div>
        {inspection.error ? (
          <InlineAlert
            className="m-2 mb-0"
            error={inspection.error}
            tone="error"
          />
        ) : null}
        <RunConfigurationFlutterDevicePickerList
          currentDeviceId={currentDeviceId}
          devices={inspection.data?.devices ?? []}
          fetched={inspection.isFetched}
          fetching={inspection.isFetching}
          onChoose={(device) => {
            onChoose(device.id);
            setOpen(false);
          }}
        />
        {inspection.data?.diagnostics.length ? (
          <InlineAlert
            className="m-2 mt-0"
            tone={
              inspection.data.diagnostics.some(
                ({ severity }) => severity === "error",
              )
                ? "error"
                : "warning"
            }
          >
            {inspection.data.diagnostics
              .map(({ message }) => message)
              .join(" ")}
          </InlineAlert>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
