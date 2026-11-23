import { useState } from "react";
import {
  saveSidebarAutoExpandFolders,
  useSidebarAutoExpandFolders,
} from "@/lib/sidebar-file-preferences";

export function FileNavigationSettings() {
  const enabled = useSidebarAutoExpandFolders();
  const [error, setError] = useState(false);
  return (
    <section className="px-3 py-3">
      <label className="flex cursor-pointer items-center justify-between gap-4 text-sm">
        <span>
          <span className="font-semibold">Auto-expand nested folders</span>
          <span className="mt-1 block text-xs text-muted-foreground">
            When a folder contains only another folder, keep expanding until you
            reach files, an empty folder, or multiple folders. Saved on this
            device.
          </span>
        </span>
        <input
          type="checkbox"
          aria-label="Auto-expand nested folders"
          className="size-3.5 shrink-0 accent-primary"
          checked={enabled}
          onChange={(event) => {
            try {
              saveSidebarAutoExpandFolders(event.target.checked);
              setError(false);
            } catch {
              setError(true);
            }
          }}
        />
      </label>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          Could not save this file navigation preference.
        </p>
      ) : null}
    </section>
  );
}
