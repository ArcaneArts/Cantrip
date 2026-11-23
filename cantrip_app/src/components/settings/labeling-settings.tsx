import {
  isLanguageModelProfile,
  type ModelProfileSummary,
  type UserSettings,
  type UserSettingsUpdate,
} from "@cantrip/protocol";
import { ModelCombobox } from "@/components/chat/model-combobox";

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
  const selected = models.find(({ id }) => id === settings.labelingModelId);
  const unavailable = Boolean(
    settings.labelingModelId &&
    (!selected || !isLanguageModelProfile(selected)),
  );
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
          <p className="text-xs font-medium">Labeling model</p>
          <p className="text-[11px] text-muted-foreground">
            Uses the lowest known thinking effort; otherwise keeps the default.
          </p>
        </div>
        <div className="grid w-full gap-1 sm:w-72">
          <ModelCombobox
            ariaLabel="Labeling model"
            models={models}
            value={settings.labelingModelId ?? ""}
            disabled={pending}
            noneLabel="Use default model"
            placeholder={
              unavailable ? "Choose a language model" : "Use default model"
            }
            onValueChange={(id) => update({ labelingModelId: id || null })}
          />
          {unavailable ? (
            <p className="text-[11px] text-muted-foreground">
              The saved model is unavailable for titles. Choose a language model
              or use the default.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
