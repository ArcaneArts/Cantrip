import { useState } from "react";
import { NativeSelect } from "@/components/ui/native-select";
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
    <div>
      <label className="flex items-center justify-between gap-4 py-2 text-sm">
        {label}
        <NativeSelect
          aria-label={label}
          value={value}
          className="w-24"
          size="sm"
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
        </NativeSelect>
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
    <section className="grid gap-2">
      <h3 className="text-sm font-semibold">Tab bar display</h3>
      <div className="divide-y border-y">
        <BarSetting bar="top" label="Top tab bar" />
        <BarSetting bar="bottom" label="Bottom rail" />
      </div>
      <p className="text-xs text-muted-foreground">
        Hybrid switches trailing tabs to icons as space runs out. The right rail
        always uses icons.
      </p>
    </section>
  );
}
