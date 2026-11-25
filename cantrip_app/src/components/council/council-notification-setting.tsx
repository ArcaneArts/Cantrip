import {
  setCouncilNotificationsEnabled,
  useCouncilNotificationPreference,
} from "@/lib/council-notification-preference";

export function CouncilNotificationSetting() {
  const enabled = useCouncilNotificationPreference();
  return (
    <label className="flex items-center justify-between gap-3 px-3 py-3 text-sm">
      Show Council notifications on this device
      <input
        type="checkbox"
        checked={enabled}
        onChange={(event) =>
          setCouncilNotificationsEnabled(event.target.checked)
        }
      />
    </label>
  );
}
