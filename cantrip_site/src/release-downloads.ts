export type DesktopPlatform = "macos" | "windows" | "other";

export interface LatestDesktopRelease {
  changelogUrl: string;
  macosUrl: string;
  version: string;
  windowsUrl: string;
}

export interface BrowserPlatformInfo {
  platform?: string;
  userAgent?: string;
}

export const GITHUB_URL = "https://github.com/ArcaneArts/Cantrip";
export const LATEST_RELEASE_API_URL =
  "https://api.github.com/repos/ArcaneArts/Cantrip/releases/latest";
export const LATEST_RELEASE_URL = `${GITHUB_URL}/releases/latest`;

const RELEASE_DOWNLOAD_PREFIX = `${GITHUB_URL}/releases/download/`;
const RELEASE_TAG_PREFIX = `${GITHUB_URL}/releases/tag/`;
const VERSION_PATTERN = /^v?(\d+\.\d+\.\d+)$/u;

export function detectDesktopPlatform({
  platform = "",
  userAgent = "",
}: BrowserPlatformInfo): DesktopPlatform {
  const normalizedPlatform = platform.toLowerCase();
  const normalizedAgent = userAgent.toLowerCase();
  if (/android|iphone|ipad|ipod|mobile/u.test(normalizedAgent)) return "other";
  if (
    normalizedPlatform.startsWith("win") ||
    normalizedAgent.includes("windows")
  ) {
    return "windows";
  }
  if (
    normalizedPlatform.includes("mac") ||
    normalizedAgent.includes("mac os")
  ) {
    return "macos";
  }
  return "other";
}

function stringProperty(
  value: Record<string, unknown>,
  key: string,
): string | null {
  const property = value[key];
  return typeof property === "string" ? property : null;
}

function trustedAssetUrl(
  value: unknown,
  tag: string,
  filename: string,
): string | null {
  if (typeof value !== "string") return null;
  const expected = `${RELEASE_DOWNLOAD_PREFIX}${tag}/${filename}`;
  return value === expected ? value : null;
}

export function parseLatestDesktopRelease(
  value: unknown,
): LatestDesktopRelease | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const tag = stringProperty(record, "tag_name");
  const changelogUrl = stringProperty(record, "html_url");
  const match = tag?.match(VERSION_PATTERN);
  if (!tag || !match || changelogUrl !== `${RELEASE_TAG_PREFIX}${tag}`) {
    return null;
  }
  const version = match[1];
  if (!version) return null;
  const assets = record.assets;
  if (!Array.isArray(assets)) return null;

  const assetUrl = (filename: string): string | null => {
    const asset = assets.find(
      (candidate) =>
        candidate !== null &&
        typeof candidate === "object" &&
        !Array.isArray(candidate) &&
        stringProperty(candidate as Record<string, unknown>, "name") ===
          filename,
    );
    if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
      return null;
    }
    return trustedAssetUrl(
      (asset as Record<string, unknown>).browser_download_url,
      tag,
      filename,
    );
  };

  const macosUrl = assetUrl(`Cantrip_${version}_aarch64.dmg`);
  const windowsUrl = assetUrl(`Cantrip_${version}_x64-setup.exe`);
  if (!macosUrl || !windowsUrl) return null;
  return { changelogUrl, macosUrl, version, windowsUrl };
}

export function platformDownload(
  platform: DesktopPlatform,
  release: LatestDesktopRelease,
): { href: string; label: string } | null {
  if (platform === "macos") {
    return { href: release.macosUrl, label: "Download for macOS" };
  }
  if (platform === "windows") {
    return { href: release.windowsUrl, label: "Download for Windows" };
  }
  return null;
}
