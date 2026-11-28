import { useId, useState } from "react";
import {
  saveFileChangeShimmer,
  useFileChangeShimmer,
} from "@/lib/file-change-preference";

export function FileChangeSettings() {
  const labelId = useId();
  const descriptionId = useId();
  const enabled = useFileChangeShimmer();
  const [error, setError] = useState(false);
  return (
    <section className="grid gap-2">
      <label className="flex cursor-pointer items-center justify-between gap-4 border-y py-3 text-sm">
        <span className="grid min-w-0 gap-1">
          <span id={labelId}>File change shimmer</span>
          <span id={descriptionId} className="text-xs text-muted-foreground">
            Highlight sidebar changes with green for added, yellow for modified,
            and red for deleted. Hidden files highlight their folder.
          </span>
        </span>
        <input
          aria-labelledby={labelId}
          aria-describedby={descriptionId}
          type="checkbox"
          className="size-3.5 shrink-0 accent-primary"
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
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          Could not save this display preference.
        </p>
      ) : null}
    </section>
  );
}
