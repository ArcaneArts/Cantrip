export const CUA_SIGNING_IDENTIFIER = "art.cantrip.cua";
export const CUA_DEVELOPMENT_SIGNING_IDENTIFIER = "art.cantrip.cua.dev";

export function cantripCuaExecutableName(platform = process.platform) {
  return platform === "win32" ? "cantrip-cua.exe" : "cantrip-cua";
}
