import { useEffect, useState } from "react";

import { settingsSlashCommand, type SettingsPicker } from "./slash-commands";

/** Shared by palette selection and direct submission. No settings command is
 * forwarded to the agent, including invalid or temporarily unavailable ones. */
export function useSettingsSlashCommands({
  chatId,
  draft,
  enabled,
  relocationActive,
  modelPending,
  consumeDraft,
  dismissMenu,
  notice,
}: {
  chatId: string;
  draft: string;
  enabled: boolean;
  relocationActive: boolean;
  modelPending: boolean;
  consumeDraft(): void;
  dismissMenu(): void;
  notice(message: string | null): void;
}) {
  const [settingsPicker, setSettingsPicker] = useState<SettingsPicker | null>(
    null,
  );
  useEffect(() => setSettingsPicker(null), [chatId]);
  const settingsCommand = enabled ? settingsSlashCommand(draft) : null;

  const runSettingsCommand = (text: string): boolean => {
    const command = enabled ? settingsSlashCommand(text) : null;
    if (!command) return false;
    if (relocationActive) return true;
    dismissMenu();
    if (command.arguments) {
      notice(
        `Use /${command.name} without arguments to open the ${command.name} picker.`,
      );
      return true;
    }
    if (command.name === "model" && modelPending) return true;
    consumeDraft();
    notice(null);
    setSettingsPicker(command.name);
    return true;
  };

  return {
    settingsCommand,
    settingsPicker,
    setSettingsPicker,
    runSettingsCommand,
  };
}
