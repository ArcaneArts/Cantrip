import { openSettingsBundleWire } from "@/lib/protected-secrets";
import { request } from "@/lib/api-client";
import type {
  UserSettingsUpdate,
  AppDestinationUpdate,
} from "@cantrip/protocol";
import {
  appDestinationSchema,
  appDestinationUpdateSchema,
} from "@cantrip/protocol";

export async function getSettings() {
  return openSettingsBundleWire(await request("/api/settings"));
}

export async function updateSettings(input: UserSettingsUpdate) {
  return openSettingsBundleWire(
    await request("/api/settings", {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  );
}

export async function updateAppDestination(input: AppDestinationUpdate) {
  return appDestinationSchema.parse(
    await request("/api/settings/destination", {
      method: "PATCH",
      body: JSON.stringify(appDestinationUpdateSchema.parse(input)),
    }),
  );
}
