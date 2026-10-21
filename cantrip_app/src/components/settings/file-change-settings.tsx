import { useState } from "react";
import {
  saveFileChangeShimmer,
  useFileChangeShimmer,
} from "@/lib/file-change-preference";

export function FileChangeSettings() {
  const enabled = useFileChangeShimmer();
  const [error, setError] = useState(false);
  return (
    <section className="grid gap-2 border-b pb-5">
      <label className="flex cursor-pointer items-center justify-between gap-4 text-sm">
        File change shimmer
        <input
          type="checkbox"
          className="size-3.5 accent-primary"
          checked={enabled}
          onChange={(event) => {
            try {
              saveFileChangeShimmer(event.target.checked);
              setError(false);
            } catch {
              setError(true);
            }
          }}
        />
      </label>
      <p className="text-xs text-muted-foreground">
        Briefly highlight changed file names: green for added, yellow for
        modified, and red for deleted. Hidden files highlight their nearest
        visible folder. Saved on this device.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          Could not save this display preference.
        </p>
      ) : null}
    </section>
  );
}
