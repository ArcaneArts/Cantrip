import { isDeepStrictEqual } from "node:util";

export const sourceMountsLabel = "io.cantrip.os.source-mounts";

/** Change image defaults while retaining explicit container overrides. This
 * does not merge root filesystem changes; those belong to the selected image. */
export function imageDefaults(original, oldImage, newImage) {
  const config = structuredClone(original.Config);
  for (const key of new Set([
    ...Object.keys(oldImage.Config),
    ...Object.keys(newImage.Config),
  ]))
    if (isDeepStrictEqual(config[key], oldImage.Config[key]))
      config[key] = newImage.Config[key];
  const envMap = (values) =>
    new Map(
      (values ?? []).map((entry) => {
        const at = entry.indexOf("=");
        return at < 0
          ? [entry, undefined]
          : [entry.slice(0, at), entry.slice(at + 1)];
      }),
    );
  const oldDefaults = envMap(oldImage.Config.Env),
    env = envMap(newImage.Config.Env);
  for (const [key, value] of envMap(original.Config.Env))
    if (!oldDefaults.has(key) || value !== oldDefaults.get(key))
      env.set(key, value);
  config.Env = [...env].map(([key, value]) =>
    value === undefined ? key : `${key}=${value}`,
  );
  config.Labels = { ...newImage.Config.Labels };
  for (const [key, value] of Object.entries(original.Config.Labels ?? {}))
    if (value !== oldImage.Config.Labels?.[key]) config.Labels[key] = value;
  config.Labels["io.cantrip.os"] = "foundation";
  config.Labels[sourceMountsLabel] =
    original.Config.Labels?.[sourceMountsLabel];
  return { ...original, Config: config };
}
