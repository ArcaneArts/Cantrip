import type {
  ModelProfileSummary,
  UserSettings,
  UserSettingsUpdate,
} from "@cantrip/protocol";

export function LabelingSettings({
  settings,
  models,
  pending,
  update,
}: {
  settings: UserSettings;
  models: ModelProfileSummary[];
  pending: boolean;
  update(input: UserSettingsUpdate): void;
}) {
  return (
    <div className="space-y-3 border-t px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Automatic titles</h2>
          <p className="text-xs text-muted-foreground">
            Tasks: up to six words. Chats and agents: up to three.
          </p>
        </div>
        <div className="flex flex-wrap gap-4 text-xs">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className="size-3.5 accent-primary"
              checked={settings.autoNameTasks}
              disabled={pending}
              onChange={(event) =>
                update({ autoNameTasks: event.target.checked })
              }
            />
            Task names
          </label>
          <label
            className="flex items-center gap-2"
            title={
              settings.randomAgentNames
                ? "Paused while random names are enabled"
                : undefined
            }
          >
            <input
              type="checkbox"
              className="size-3.5 accent-primary"
              checked={settings.autoNameChats}
              disabled={pending || settings.randomAgentNames}
              onChange={(event) =>
                update({ autoNameChats: event.target.checked })
              }
            />
            Chat and agent titles
          </label>
        </div>
      </div>
      {settings.randomAgentNames ? (
        <p className="text-xs text-muted-foreground">
          Chat titling is paused while random names are enabled. Its setting is
          retained.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <label htmlFor="labeling-model" className="text-xs font-medium">
            Labeling model
          </label>
          <p className="text-[11px] text-muted-foreground">
            Uses the lowest known thinking effort; otherwise keeps the default.
          </p>
        </div>
        <select
          id="labeling-model"
          className="max-w-full rounded-md border bg-background px-2 py-1.5 text-xs"
          value={settings.labelingModelId ?? ""}
          disabled={pending}
          onChange={(event) =>
            update({ labelingModelId: event.target.value || null })
          }
        >
          <option value="">Use default model</option>
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
