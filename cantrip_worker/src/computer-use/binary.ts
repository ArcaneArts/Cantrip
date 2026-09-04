import { fileURLToPath } from "node:url";

/** Select one executable; the requested operation will determine whether it runs. */
export function resolveCuaBinary({
  override = process.env.CANTRIP_CUA_BIN,
  moduleUrl = import.meta.url,
  platform = process.platform,
}: {
  override?: string;
  moduleUrl?: string;
  platform?: NodeJS.Platform;
} = {}): string {
  if (override !== undefined) return override;
  const executable = platform === "win32" ? "cantrip-cua.exe" : "cantrip-cua";
  return fileURLToPath(new URL(`../../bin/${executable}`, moduleUrl), {
    windows: platform === "win32",
  });
}
