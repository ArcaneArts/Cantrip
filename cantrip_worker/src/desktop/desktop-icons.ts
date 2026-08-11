import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { RemoteDesktopApplicationIcon } from "@cantrip/protocol";

const CACHE_VERSION = "v1";
const ICON_SIZE = 64;
const MAX_ICON_BYTES = 128_000;
const NEGATIVE_CACHE_TTL_MS = 24 * 60 * 60_000;

export interface DesktopApplicationIconProvider {
  register(application: string): string;
  resolve(key: string): Promise<RemoteDesktopApplicationIcon>;
}

function normalizedApplication(application: string): string {
  return application.trim().normalize("NFKC").toLocaleLowerCase();
}

function iconKey(application: string): string {
  const digest = createHash("sha256")
    .update(
      `${CACHE_VERSION}\0${process.platform}\0${normalizedApplication(application)}`,
    )
    .digest("hex")
    .slice(0, 40);
  return `desktop-app-${CACHE_VERSION}-${digest}`;
}

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(
    () => true,
    () => false,
  );
}

function execute(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeout?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        env: options.env ?? process.env,
        maxBuffer: 2 * 1024 * 1024,
        timeout: options.timeout ?? 5_000,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

function spotlightLiteral(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

async function macApplicationBundle(
  application: string,
): Promise<string | null> {
  if (application.endsWith(".app") && (await exists(application))) {
    return application;
  }
  const directNames = application.endsWith(".app")
    ? [application]
    : [`${application}.app`];
  for (const root of [
    "/Applications",
    "/System/Applications",
    "/System/Applications/Utilities",
    path.join(os.homedir(), "Applications"),
  ]) {
    for (const name of directNames) {
      const candidate = path.join(root, name);
      if (await exists(candidate)) return candidate;
    }
  }

  const literal = spotlightLiteral(application.replace(/\.app$/iu, ""));
  const query =
    'kMDItemContentType == "com.apple.application-bundle" && ' +
    `(kMDItemDisplayName == "${literal}"cd || ` +
    `kMDItemFSName == "${literal}.app"cd || ` +
    `kMDItemCFBundleIdentifier == "${literal}"cd)`;
  try {
    const output = await execute("mdfind", [query]);
    return (
      output
        .split(/\r?\n/u)
        .map((entry) => entry.trim())
        .find((entry) => entry.endsWith(".app")) ?? null
    );
  } catch {
    return null;
  }
}

async function plistValue(
  plistPath: string,
  key: string,
): Promise<string | null> {
  try {
    const value = (
      await execute("plutil", ["-extract", key, "raw", "-o", "-", plistPath])
    ).trim();
    return value || null;
  } catch {
    return null;
  }
}

async function macIconSource(application: string): Promise<string | null> {
  const bundle = await macApplicationBundle(application);
  if (!bundle) return null;
  const resources = path.join(bundle, "Contents", "Resources");
  const plist = path.join(bundle, "Contents", "Info.plist");
  const configured =
    (await plistValue(plist, "CFBundleIconFile")) ??
    (await plistValue(plist, "CFBundleIconName"));
  if (configured) {
    for (const name of configured.endsWith(".icns")
      ? [configured]
      : [configured, `${configured}.icns`]) {
      const candidate = path.join(resources, name);
      if (await exists(candidate)) return candidate;
    }
  }
  try {
    const entries = await readdir(resources);
    const fallback = entries.find((entry) => entry.endsWith(".icns"));
    return fallback ? path.join(resources, fallback) : null;
  } catch {
    return null;
  }
}

async function windowsIconPng(
  application: string,
  outputPath: string,
): Promise<boolean> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$needle = $env:CANTRIP_ICON_APPLICATION",
    "$process = Get-Process | Where-Object {",
    "  $_.ProcessName -ieq $needle -or $_.ProcessName -ieq ($needle -replace '\\.exe$','') -or $_.MainWindowTitle -ieq $needle",
    "} | Select-Object -First 1",
    "if (-not $process -or -not $process.Path) { exit 3 }",
    "Add-Type -AssemblyName System.Drawing",
    "$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($process.Path)",
    "if (-not $icon) { exit 4 }",
    "$bitmap = $icon.ToBitmap()",
    "$bitmap.Save($env:CANTRIP_ICON_OUTPUT, [System.Drawing.Imaging.ImageFormat]::Png)",
    "$bitmap.Dispose()",
    "$icon.Dispose()",
  ].join("\n");
  try {
    await execute(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        env: {
          ...process.env,
          CANTRIP_ICON_APPLICATION: application,
          CANTRIP_ICON_OUTPUT: outputPath,
        },
        timeout: 8_000,
      },
    );
    return exists(outputPath);
  } catch {
    return false;
  }
}

interface LinuxDesktopEntry {
  exec: string | null;
  icon: string | null;
  name: string | null;
  startupClass: string | null;
}

function parseDesktopEntry(contents: string): LinuxDesktopEntry {
  const values = new Map<string, string>();
  let inDesktopEntry = false;
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      inDesktopEntry = line === "[Desktop Entry]";
      continue;
    }
    if (!inDesktopEntry || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator > 0)
      values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return {
    exec: values.get("Exec") ?? null,
    icon: values.get("Icon") ?? null,
    name: values.get("Name") ?? null,
    startupClass: values.get("StartupWMClass") ?? null,
  };
}

function desktopEntryMatches(
  entry: LinuxDesktopEntry,
  application: string,
): boolean {
  const needle = normalizedApplication(application).replace(/\.desktop$/u, "");
  const executable = entry.exec?.split(/\s+/u)[0]?.replace(/^['"]|['"]$/gu, "");
  return [
    entry.name,
    entry.startupClass,
    executable ? path.basename(executable) : null,
  ].some((value) => value && normalizedApplication(value) === needle);
}

async function linuxIconSource(application: string): Promise<string | null> {
  const desktopRoots = [
    path.join(
      process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"),
      "applications",
    ),
    "/usr/local/share/applications",
    "/usr/share/applications",
  ];
  let iconName: string | null = null;
  for (const root of desktopRoots) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const fileName of entries.filter((entry) =>
      entry.endsWith(".desktop"),
    )) {
      try {
        const entry = parseDesktopEntry(
          await readFile(path.join(root, fileName), "utf8"),
        );
        if (desktopEntryMatches(entry, application)) {
          iconName = entry.icon;
          break;
        }
      } catch {
        // A malformed application entry should not block the rest of inventory.
      }
    }
    if (iconName) break;
  }
  if (!iconName) return null;
  if (path.isAbsolute(iconName))
    return (await exists(iconName)) ? iconName : null;
  const iconRoots = [
    process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"),
    "/usr/local/share",
    "/usr/share",
  ];
  const sizes = ["64x64", "128x128", "256x256", "48x48", "scalable"];
  const extensions = ["png", "svg", "xpm"];
  for (const root of iconRoots) {
    for (const size of sizes) {
      for (const extension of extensions) {
        const candidate = path.join(
          root,
          "icons",
          "hicolor",
          size,
          "apps",
          `${iconName}.${extension}`,
        );
        if (await exists(candidate)) return candidate;
      }
    }
    for (const extension of extensions) {
      const candidate = path.join(root, "pixmaps", `${iconName}.${extension}`);
      if (await exists(candidate)) return candidate;
    }
  }
  return null;
}

async function normalizedPng(source: string): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp(source, { density: 144 })
    .resize(ICON_SIZE, ICON_SIZE, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
      withoutEnlargement: true,
    })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function extractIcon(application: string): Promise<Buffer | null> {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "cantrip-icon-"));
  try {
    let source: string | null = null;
    if (process.platform === "darwin") {
      source = await macIconSource(application);
      if (source?.endsWith(".icns")) {
        const converted = path.join(temporaryRoot, "icon.png");
        try {
          await execute("sips", [
            "-s",
            "format",
            "png",
            "-Z",
            String(ICON_SIZE),
            source,
            "--out",
            converted,
          ]);
          source = converted;
        } catch {
          return null;
        }
      }
    } else if (process.platform === "win32") {
      const extracted = path.join(temporaryRoot, "icon.png");
      if (await windowsIconPng(application, extracted)) source = extracted;
    } else if (process.platform === "linux") {
      source = await linuxIconSource(application);
    }
    if (!source) return null;
    const png = await normalizedPng(source);
    return png.byteLength <= MAX_ICON_BYTES ? png : null;
  } catch {
    return null;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

export class DesktopApplicationIconStore implements DesktopApplicationIconProvider {
  readonly #applications = new Map<string, string>();
  readonly #cacheDirectory: string;
  readonly #memory = new Map<string, string | null>();
  readonly #pending = new Map<string, Promise<string | null>>();
  readonly #extract: (application: string) => Promise<Buffer | null>;

  constructor(
    dataDirectory: string,
    extract: (application: string) => Promise<Buffer | null> = extractIcon,
  ) {
    this.#cacheDirectory = path.join(
      dataDirectory,
      "desktop",
      "application-icons",
    );
    this.#extract = extract;
  }

  register(application: string): string {
    const key = iconKey(application);
    this.#applications.set(key, application);
    return key;
  }

  async resolve(key: string): Promise<RemoteDesktopApplicationIcon> {
    const data = await this.resolveData(key);
    return { key, mimeType: "image/png", data };
  }

  private async resolveData(key: string): Promise<string | null> {
    if (this.#memory.has(key)) return this.#memory.get(key) ?? null;
    const existing = this.#pending.get(key);
    if (existing) return existing;
    const pending = this.loadOrExtract(key).finally(() =>
      this.#pending.delete(key),
    );
    this.#pending.set(key, pending);
    const value = await pending;
    this.#memory.set(key, value);
    return value;
  }

  private async loadOrExtract(key: string): Promise<string | null> {
    const application = this.#applications.get(key);
    if (!application) return null;
    const pngPath = path.join(this.#cacheDirectory, `${key}.png`);
    const missingPath = path.join(this.#cacheDirectory, `${key}.missing`);
    try {
      const cached = await readFile(pngPath);
      if (cached.byteLength <= MAX_ICON_BYTES) return cached.toString("base64");
    } catch {
      // Cache miss; continue to platform discovery.
    }
    try {
      const missing = await stat(missingPath);
      if (Date.now() - missing.mtimeMs < NEGATIVE_CACHE_TTL_MS) return null;
    } catch {
      // No recent negative cache entry.
    }
    const png = await this.#extract(application);
    await mkdir(this.#cacheDirectory, { recursive: true });
    if (!png) {
      await writeFile(missingPath, new Date().toISOString()).catch(
        () => undefined,
      );
      return null;
    }
    await writeFile(pngPath, png);
    await rm(missingPath, { force: true }).catch(() => undefined);
    return png.toString("base64");
  }
}
