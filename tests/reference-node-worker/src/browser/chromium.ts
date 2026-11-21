import { accessSync, constants } from "node:fs";
import os from "node:os";
import path from "node:path";

function executable(pathname: string | undefined): string | null {
  if (!pathname) return null;
  try {
    accessSync(pathname, constants.X_OK);
    return pathname;
  } catch {
    return null;
  }
}

function candidates(): string[] {
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi",
      path.join(
        os.homedir(),
        "Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ),
      path.join(
        os.homedir(),
        "Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      ),
    ];
  }
  if (process.platform === "win32") {
    const programFiles = [
      process.env.PROGRAMFILES,
      process.env["PROGRAMFILES(X86)"],
      process.env.LOCALAPPDATA,
    ].filter((value): value is string => Boolean(value));
    return programFiles.flatMap((root) => [
      path.join(root, "Google/Chrome/Application/chrome.exe"),
      path.join(root, "Chromium/Application/chrome.exe"),
      path.join(root, "BraveSoftware/Brave-Browser/Application/brave.exe"),
      path.join(root, "Microsoft/Edge/Application/msedge.exe"),
    ]);
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/brave-browser",
    "/usr/bin/microsoft-edge",
  ];
}

export function findChromiumExecutable(): string | null {
  return (
    executable(process.env.CANTRIP_CHROMIUM_EXECUTABLE) ??
    candidates()
      .map(executable)
      .find((value): value is string => Boolean(value)) ??
    null
  );
}
