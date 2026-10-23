const platformAliases = new Map([
  ["darwin", "darwin"],
  ["macos", "darwin"],
  ["linux", "linux"],
  ["win32", "win32"],
  ["windows", "win32"],
]);
const supportedArchitectures = new Set(["x64", "arm64", "armhf"]);

export function hostTarget() {
  return `${process.platform}-${process.arch}`;
}

export function normalizeTarget(value = hostTarget()) {
  const separator = value.lastIndexOf("-");
  if (separator <= 0) throw new Error(`Invalid native target: ${value}`);
  const platform = platformAliases.get(value.slice(0, separator).toLowerCase());
  const arch = value.slice(separator + 1).toLowerCase();
  if (!platform || !supportedArchitectures.has(arch)) {
    throw new Error(
      `Unsupported native target ${value}. Expected darwin-{x64,arm64}, ` +
        "linux-{x64,arm64,armhf}, or win32-{x64,arm64}.",
    );
  }
  if (arch === "armhf" && platform !== "linux") {
    throw new Error(`Unsupported native target ${value}`);
  }
  return { platform, arch, id: `${platform}-${arch}` };
}
