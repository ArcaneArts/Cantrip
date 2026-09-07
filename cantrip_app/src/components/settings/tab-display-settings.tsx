import { useState } from "react";
import {
  saveTabDisplay,
  useTabDisplay,
  type ConfigurableTabBar,
  type TabDisplayMode,
} from "@/lib/tab-display";

function BarSetting({
  bar,
  label,
}: {
  bar: ConfigurableTabBar;
  label: string;
}) {
  const value = useTabDisplay(bar);
  const [error, setError] = useState(false);
  return (
    <div className="grid gap-2">
      <label className="flex items-center justify-between gap-4 text-sm">
        {label}
        <select
          aria-label={label}
          value={value}
          className="rounded-md border bg-background px-2 py-1"
          onChange={(event) => {
            try {
              saveTabDisplay(bar, event.target.value as TabDisplayMode);
              setError(false);
            } catch {
              setError(true);
            }
          }}
        >
          <option value="tabs">Tabs</option>
          <option value="icons">Icons</option>
          <option value="hybrid">Hybrid</option>
        </select>
      </label>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          Could not save this display preference.
        </p>
      ) : null}
    </div>
  );
}
export function TabDisplaySettings() {
  return (
    <section className="grid gap-4 border-b pb-5">
      <h3 className="text-sm font-semibold">Tab bar display</h3>
      <BarSetting bar="top" label="Top tab bar" />
      <BarSetting bar="bottom" label="Bottom rail" />
      <p className="text-xs text-muted-foreground">
        Hybrid collapses trailing labels to icons as space runs out. The right
        rail always uses icons. These display preferences are saved on this
        device.
      </p>
    </section>
  );
}
