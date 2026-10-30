import { useState } from "react";
import {
  saveCodeEditorLineNumbers,
  useCodeEditorLineNumbers,
} from "@/lib/code-editor-preferences";

export function CodeEditorSettings() {
  const enabled = useCodeEditorLineNumbers();
  const [error, setError] = useState(false);
  return (
    <section className="grid gap-3 border-y py-4">
      <label className="flex cursor-pointer items-center justify-between gap-4 text-sm">
        Show line numbers
        <input
          type="checkbox"
          className="size-3.5 accent-primary"
          checked={enabled}
          onChange={(event) => {
            try {
              saveCodeEditorLineNumbers(event.target.checked);
              setError(false);
            } catch {
              setError(true);
            }
          }}
        />
      </label>
      <p className="text-xs text-muted-foreground">
        Show line numbers in code editors and viewers. Saved on this device.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          Could not save this editor preference.
        </p>
      ) : null}
    </section>
  );
}
