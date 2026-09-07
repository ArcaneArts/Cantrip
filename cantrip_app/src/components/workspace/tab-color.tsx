import { useEffect, useState, type ReactNode } from "react";
import { Palette, SquareTerminal } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { StyledContextMenuItem } from "@/components/ui/styled-menu";
import {
  TAB_COLOR_DIALOG_EVENT,
  TAB_COLOR_PRESETS,
  openTabColorDialog,
  readTabHue,
  saveTabHue,
  tabColorStyle,
  useTabHue,
} from "@/lib/tab-colors";
import "./tab-color.css";

export function TabColor({
  colorKey,
  active,
  children,
}: {
  colorKey: string;
  active: boolean;
  children: ReactNode;
}) {
  const hue = useTabHue(colorKey);
  return (
    <div
      className="tab-color contents"
      data-tab-color={hue === null ? "neutral" : "hue"}
      data-color-active={active}
      style={tabColorStyle(hue)}
    >
      {children}
    </div>
  );
}

export function TabIndicator({
  active,
  edge = "bottom",
}: {
  active: boolean;
  edge?: "top" | "bottom" | "left";
}) {
  return (
    <span
      aria-hidden="true"
      className="tab-color-underline"
      data-active={active}
      data-edge={edge}
    />
  );
}

export function TabColorMenuItem({
  colorKey,
  title,
}: {
  colorKey: string;
  title: string;
}) {
  return (
    <StyledContextMenuItem
      onSelect={() => {
        // Let the context menu restore focus before the dialog takes ownership.
        window.setTimeout(() => openTabColorDialog(colorKey, title), 0);
      }}
    >
      <Palette className="size-4" /> Color…
    </StyledContextMenuItem>
  );
}

export function TabColorDialogHost() {
  const [target, setTarget] = useState<{ key: string; title: string } | null>(
    null,
  );
  useEffect(() => {
    const open = (event: Event) => setTarget((event as CustomEvent).detail);
    window.addEventListener(TAB_COLOR_DIALOG_EVENT, open);
    return () => window.removeEventListener(TAB_COLOR_DIALOG_EVENT, open);
  }, []);
  return target ? (
    <TabColorDialog
      key={target.key}
      target={target}
      onClose={() => setTarget(null)}
    />
  ) : null;
}

export function TabColorDialog({
  target,
  onClose,
}: {
  target: { key: string; title: string };
  onClose(): void;
}) {
  const [hue, setHue] = useState(() => readTabHue(target.key));
  const [custom, setCustom] = useState(
    () =>
      hue !== null && !TAB_COLOR_PRESETS.some((preset) => preset.hue === hue),
  );
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Tab color</DialogTitle>
          <DialogDescription>
            Choose a color for {target.title}. Only its icon, text, and
            underline change. Saved on this device.
          </DialogDescription>
        </DialogHeader>
        <div
          role="radiogroup"
          aria-label="Tab color"
          className="flex flex-wrap gap-2"
          onKeyDown={(event) => {
            if (
              ![
                "ArrowLeft",
                "ArrowRight",
                "ArrowUp",
                "ArrowDown",
                "Home",
                "End",
              ].includes(event.key)
            )
              return;
            event.preventDefault();
            const options = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                '[role="radio"]',
              ),
            );
            const current = options.indexOf(event.target as HTMLButtonElement);
            const direction =
              event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? options.length - 1
                  : (current + direction + options.length) % options.length;
            options[next]?.focus();
            options[next]?.click();
          }}
        >
          <Button
            role="radio"
            aria-checked={hue === null}
            tabIndex={hue === null ? 0 : -1}
            variant={hue === null ? "default" : "outline"}
            onClick={() => {
              setHue(null);
              setCustom(false);
            }}
          >
            Neutral
          </Button>
          {TAB_COLOR_PRESETS.map((preset) => (
            <Button
              key={preset.label}
              role="radio"
              aria-checked={!custom && hue === preset.hue}
              tabIndex={!custom && hue === preset.hue ? 0 : -1}
              variant={!custom && hue === preset.hue ? "default" : "outline"}
              onClick={() => {
                setHue(preset.hue);
                setCustom(false);
              }}
            >
              <span
                className="size-3 rounded-full"
                style={{ backgroundColor: `hsl(${preset.hue} 65% 50%)` }}
              />
              {preset.label}
            </Button>
          ))}
          <Button
            role="radio"
            aria-checked={custom}
            tabIndex={custom ? 0 : -1}
            variant={custom ? "default" : "outline"}
            onClick={() => {
              setCustom(true);
              setHue(hue ?? 180);
            }}
          >
            Custom
          </Button>
        </div>
        {custom ? (
          <label className="grid gap-2 text-sm">
            Hue: {hue}°
            <input
              aria-label="Custom hue"
              type="range"
              min={0}
              max={359}
              step={1}
              value={hue ?? 180}
              onChange={(event) => setHue(Number(event.target.value))}
              className="w-full"
            />
          </label>
        ) : null}
        <div
          className="tab-color flex gap-4 rounded-md border p-3"
          data-tab-color={hue === null ? "neutral" : "hue"}
          data-color-active="true"
          style={tabColorStyle(hue)}
        >
          <span className="tab-color-content flex items-center gap-2 border-b-2 border-current pb-1">
            <SquareTerminal className="size-4" />
            {target.title}
          </span>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              try {
                saveTabHue(target.key, hue);
                onClose();
              } catch {
                setError(
                  "Could not save the tab color. Device storage may be unavailable or full.",
                );
              }
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
