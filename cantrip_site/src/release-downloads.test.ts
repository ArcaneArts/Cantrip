import { describe, expect, it } from "vitest";

import {
  detectDesktopPlatform,
  parseLatestDesktopRelease,
  platformDownload,
} from "./release-downloads";

const releasePayload = {
  tag_name: "v1.2.3",
  html_url: "https://github.com/ArcaneArts/Cantrip/releases/tag/v1.2.3",
  assets: [
    {
      name: "Cantrip_1.2.3_aarch64.dmg",
      browser_download_url:
        "https://github.com/ArcaneArts/Cantrip/releases/download/v1.2.3/Cantrip_1.2.3_aarch64.dmg",
    },
    {
      name: "Cantrip_1.2.3_x64-setup.exe",
      browser_download_url:
        "https://github.com/ArcaneArts/Cantrip/releases/download/v1.2.3/Cantrip_1.2.3_x64-setup.exe",
    },
  ],
};

describe("desktop release downloads", () => {
  it("detects supported desktop systems without treating mobile as macOS", () => {
    expect(detectDesktopPlatform({ platform: "Win32" })).toBe("windows");
    expect(detectDesktopPlatform({ platform: "MacIntel" })).toBe("macos");
    expect(
      detectDesktopPlatform({
        platform: "MacIntel",
        userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) Mobile",
      }),
    ).toBe("other");
    expect(detectDesktopPlatform({ platform: "Linux x86_64" })).toBe("other");
  });

  it("selects the installers published on the latest GitHub release", () => {
    const release = parseLatestDesktopRelease(releasePayload);

    expect(release).toEqual({
      changelogUrl: "https://github.com/ArcaneArts/Cantrip/releases/tag/v1.2.3",
      macosUrl:
        "https://github.com/ArcaneArts/Cantrip/releases/download/v1.2.3/Cantrip_1.2.3_aarch64.dmg",
      version: "1.2.3",
      windowsUrl:
        "https://github.com/ArcaneArts/Cantrip/releases/download/v1.2.3/Cantrip_1.2.3_x64-setup.exe",
    });
    expect(platformDownload("macos", release!)).toEqual({
      href: release!.macosUrl,
      label: "Download for macOS",
    });
    expect(platformDownload("windows", release!)).toEqual({
      href: release!.windowsUrl,
      label: "Download for Windows",
    });
    expect(platformDownload("other", release!)).toBeNull();
  });

  it("rejects incomplete releases and untrusted asset URLs", () => {
    expect(
      parseLatestDesktopRelease({
        ...releasePayload,
        assets: releasePayload.assets.slice(0, 1),
      }),
    ).toBeNull();
    expect(
      parseLatestDesktopRelease({
        ...releasePayload,
        assets: releasePayload.assets.map((asset, index) =>
          index === 0
            ? { ...asset, browser_download_url: "https://example.com/app.dmg" }
            : asset,
        ),
      }),
    ).toBeNull();
  });
});
