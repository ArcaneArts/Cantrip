import {
  cuaCursorAppearanceSchema,
  type CuaCursorAppearance,
} from "@cantrip/protocol/computer-use";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";

export interface CursorControlsProps {
  appearance: CuaCursorAppearance;
  disabled?: boolean;
  onChange: (appearance: CuaCursorAppearance) => void;
}

interface AppearanceDraft {
  style: string;
  color: string;
  size: string;
  label: string;
  trail: boolean;
  visible: boolean;
}

export function CursorControls(props: CursorControlsProps) {
  // New remote appearance values replace the local draft. Equal values from
  // refreshed session objects preserve unfinished edits instead of resetting
  // the form on every observation or cursor movement.
  const { appearance } = props;
  const appearanceKey = JSON.stringify([
    appearance.version,
    appearance.style,
    appearance.color,
    appearance.size,
    appearance.label,
    appearance.trail,
    appearance.visible,
  ]);
  return <CursorAppearanceForm key={appearanceKey} {...props} />;
}

function CursorAppearanceForm({
  appearance,
  disabled = false,
  onChange,
}: CursorControlsProps) {
  const id = useId();
  const [draft, setDraft] = useState<AppearanceDraft>(() => ({
    style: appearance.style,
    color: appearance.color,
    size: String(appearance.size),
    label: appearance.label ?? "",
    trail: appearance.trail,
    visible: appearance.visible,
  }));
  const result = cuaCursorAppearanceSchema.safeParse({
    version: 1,
    ...draft,
    size: draft.size.trim() === "" ? Number.NaN : Number(draft.size),
    label: draft.label === "" ? null : draft.label,
  });
  const invalidFields = new Set(
    result.success ? [] : result.error.issues.map((issue) => issue.path[0]),
  );
  const updateDraft = <K extends keyof AppearanceDraft>(
    field: K,
    value: AppearanceDraft[K],
  ) => setDraft((current) => ({ ...current, [field]: value }));

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled && result.success) onChange(result.data);
      }}
    >
      <fieldset className="space-y-3" disabled={disabled}>
        <legend className="mb-3 text-sm font-medium">Cursor appearance</legend>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium" htmlFor={`${id}-style`}>
              Style
            </label>
            <NativeSelect
              aria-invalid={invalidFields.has("style") || undefined}
              className="w-full"
              disabled={disabled}
              id={`${id}-style`}
              value={draft.style}
              onChange={(event) => updateDraft("style", event.target.value)}
            >
              <option value="arrow">Arrow</option>
              <option value="dot">Dot</option>
              <option value="ring">Ring</option>
              <option value="crosshair">Crosshair</option>
            </NativeSelect>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium" htmlFor={`${id}-size`}>
              Size
            </label>
            <Input
              aria-describedby={`${id}-size-help`}
              aria-invalid={invalidFields.has("size") || undefined}
              disabled={disabled}
              id={`${id}-size`}
              max={96}
              min={8}
              step={1}
              type="number"
              value={draft.size}
              onChange={(event) => updateDraft("size", event.target.value)}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground" id={`${id}-size-help`}>
          Whole sizes from 8 to 96.
        </p>
        <div className="space-y-1.5">
          <label className="text-xs font-medium" htmlFor={`${id}-color`}>
            Color
          </label>
          <Input
            aria-describedby={`${id}-color-help`}
            aria-invalid={invalidFields.has("color") || undefined}
            autoCapitalize="off"
            autoComplete="off"
            disabled={disabled}
            id={`${id}-color`}
            spellCheck={false}
            value={draft.color}
            onChange={(event) => updateDraft("color", event.target.value)}
          />
          <p className="text-xs text-muted-foreground" id={`${id}-color-help`}>
            Use #RRGGBB or #RRGGBBAA, including optional transparency.
          </p>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium" htmlFor={`${id}-label`}>
            Cursor label
          </label>
          <Input
            aria-describedby={`${id}-label-help`}
            aria-invalid={invalidFields.has("label") || undefined}
            autoComplete="off"
            disabled={disabled}
            id={`${id}-label`}
            value={draft.label}
            onChange={(event) => updateDraft("label", event.target.value)}
          />
          <p className="text-xs text-muted-foreground" id={`${id}-label-help`}>
            Optional. Up to 64 characters and 256 UTF-8 bytes; no control
            characters.
          </p>
        </div>
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-xs">
            <input
              checked={draft.trail}
              className="size-4 accent-primary"
              disabled={disabled}
              type="checkbox"
              onChange={(event) => updateDraft("trail", event.target.checked)}
            />
            Show trail
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              checked={draft.visible}
              className="size-4 accent-primary"
              disabled={disabled}
              type="checkbox"
              onChange={(event) => updateDraft("visible", event.target.checked)}
            />
            Show cursor
          </label>
        </div>
        {!result.success ? (
          <p className="text-xs text-destructive" role="status">
            Check the highlighted cursor settings before applying.
          </p>
        ) : null}
        <Button disabled={disabled || !result.success} size="sm" type="submit">
          Apply cursor
        </Button>
      </fieldset>
    </form>
  );
}
