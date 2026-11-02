import { useState, type ReactNode } from "react";
import {
  FILE_VIEWERS,
  type FileViewerDefinition,
} from "@/components/files/file-viewers";
import { NativeSelect } from "@/components/ui/native-select";
import {
  saveCodeEditorLineNumbers,
  useCodeEditorLineNumbers,
} from "@/lib/code-editor-preferences";
import {
  saveEditorBoolean,
  saveEditorOpeningMode,
  useEditorBoolean,
  useEditorOpeningMode,
  type EditorBooleanPreference,
} from "@/lib/editor-preferences";

const modeViewers = FILE_VIEWERS.filter((viewer) => viewer.openingModes);
const extras: readonly {
  id: EditorBooleanPreference;
  label: string;
  description: string;
  keywords: string[];
}[] = [
  {
    id: "nbt-view-mode",
    label: "Open NBT files in view mode",
    description:
      "Start in view mode. Turn off to start with NBT editing enabled.",
    keywords: ["binary minecraft tags edit"],
  },
  {
    id: "image-fit",
    label: "Fit images to the panel",
    description:
      "Scale large images to fit. Turn off to open at original size.",
    keywords: ["photo picture zoom preview"],
  },
  {
    id: "audio-loop",
    label: "Loop audio playback",
    description: "Repeat audio after playback reaches the end.",
    keywords: ["sound music repeat media"],
  },
  {
    id: "video-loop",
    label: "Loop video playback",
    description: "Repeat video after playback reaches the end.",
    keywords: ["movie repeat media"],
  },
];

function modeLabel(viewer: FileViewerDefinition) {
  return viewer.structuredFormat
    ? `${viewer.label} default mode`
    : `Open ${viewer.id === "text" ? "other text" : viewer.label} files in view mode`;
}

export const editorSettingsSearchItems = [
  {
    id: "code-editor-line-numbers",
    label: "Show line numbers",
    description: "Show or hide line numbers in code editors and viewers.",
    keywords: ["gutter margin numbering"],
  },
  ...modeViewers.map((viewer) => ({
    id: `editor-mode-${viewer.id}`,
    label: modeLabel(viewer),
    description: viewer.structuredFormat
      ? "Default to the code editor, visual editor, or view mode."
      : "Choose view mode or code editing when opening a file.",
    keywords: [viewer.id, "default opening preview", "source"],
  })),
  ...extras,
];

function PreferenceRow({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 py-3 text-sm">
      <span className="min-w-0">
        <span className="font-medium">{label}</span>
        <span className="mt-1 block text-xs text-muted-foreground">
          {description}
        </span>
      </span>
      {children}
    </label>
  );
}

const checkboxClass = "size-3.5 shrink-0 accent-primary";
function OpeningModePreference({
  viewer,
  save,
}: {
  viewer: FileViewerDefinition;
  save(action: () => void): void;
}) {
  const mode = useEditorOpeningMode(
    viewer.id,
    viewer.defaultMode,
    viewer.openingModes!,
  );
  const label = modeLabel(viewer);
  return (
    <PreferenceRow
      label={label}
      description={
        viewer.structuredFormat
          ? "Choose how this format opens. Code editor is the default."
          : viewer.id === "log"
            ? "View mode follows the latest log output. Turn off to open the code editor."
            : "Turn off to open the code editor instead."
      }
    >
      {viewer.structuredFormat ? (
        <NativeSelect
          size="sm"
          aria-label={label}
          className="shrink-0"
          value={mode}
          onChange={(event) => {
            const next = viewer.openingModes!.find(
              (candidate) => candidate === event.target.value,
            );
            if (next) save(() => saveEditorOpeningMode(viewer.id, next));
          }}
        >
          <option value="edit">Code editor</option>
          <option value="visual">Visual editor</option>
          <option value="preview">View mode</option>
        </NativeSelect>
      ) : (
        <input
          aria-label={label}
          type="checkbox"
          className={checkboxClass}
          checked={mode === "preview"}
          onChange={(event) => {
            const next = event.target.checked ? "preview" : "edit";
            save(() => saveEditorOpeningMode(viewer.id, next));
          }}
        />
      )}
    </PreferenceRow>
  );
}

function ViewerPreference({
  preference,
  save,
}: {
  preference: (typeof extras)[number];
  save(action: () => void): void;
}) {
  const checked = useEditorBoolean(preference.id);
  return (
    <PreferenceRow {...preference}>
      <input
        aria-label={preference.label}
        type="checkbox"
        className={checkboxClass}
        checked={checked}
        onChange={(event) => {
          const enabled = event.target.checked;
          save(() => saveEditorBoolean(preference.id, enabled));
        }}
      />
    </PreferenceRow>
  );
}

export function EditorsSettings({
  matchesSetting = () => true,
}: {
  matchesSetting?(id: string): boolean;
}) {
  const lineNumbers = useCodeEditorLineNumbers();
  const [error, setError] = useState(false);
  const save = (action: () => void) => {
    try {
      action();
      setError(false);
    } catch {
      setError(true);
    }
  };
  return (
    <section className="grid gap-3 py-2" aria-label="Editor preferences">
      <p className="text-xs text-muted-foreground">
        Saved on this device. Opening defaults apply to newly opened files.
      </p>
      {matchesSetting("code-editor-line-numbers") ? (
        <PreferenceRow
          label="Show line numbers"
          description="Show line numbers in code editors and viewers."
        >
          <input
            aria-label="Show line numbers"
            type="checkbox"
            className={checkboxClass}
            checked={lineNumbers}
            onChange={(event) => {
              const enabled = event.target.checked;
              save(() => saveCodeEditorLineNumbers(enabled));
            }}
          />
        </PreferenceRow>
      ) : null}
      <div>
        {modeViewers.some((viewer) =>
          matchesSetting(`editor-mode-${viewer.id}`),
        ) ? (
          <h3 className="mb-1 text-sm font-semibold">File opening modes</h3>
        ) : null}
        {modeViewers.map((viewer) =>
          matchesSetting(`editor-mode-${viewer.id}`) ? (
            <OpeningModePreference
              key={viewer.id}
              viewer={viewer}
              save={save}
            />
          ) : null,
        )}
      </div>
      <div>
        {extras.some((preference) => matchesSetting(preference.id)) ? (
          <h3 className="mb-1 text-sm font-semibold">Specialized viewers</h3>
        ) : null}
        {extras.map((preference) =>
          matchesSetting(preference.id) ? (
            <ViewerPreference
              key={preference.id}
              preference={preference}
              save={save}
            />
          ) : null,
        )}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          Could not save this editor preference.
        </p>
      ) : null}
    </section>
  );
}
