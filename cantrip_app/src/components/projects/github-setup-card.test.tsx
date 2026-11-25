import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { GithubToolsStatus } from "@cantrip/protocol";

import { GithubSetupCard } from "./github-setup-card";

const mac: GithubToolsStatus = {
  platform: "macos",
  gitInstalled: false,
  githubCliInstalled: false,
  signInCommand: "~/.local/bin/gh auth login --web",
};

function render(tools?: GithubToolsStatus, awaitingInstaller = false) {
  return renderToStaticMarkup(
    <GithubSetupCard
      tools={tools}
      workerName="Workstation"
      installing={false}
      awaitingInstaller={awaitingInstaller}
      checking={false}
      error={null}
      onSetup={() => {}}
      onCheck={() => {}}
    />,
  );
}

describe("GitHub repository setup", () => {
  it("offers setup for missing prerequisites on macOS and Windows", () => {
    expect(render(mac)).toContain("Install Git and GitHub CLI");
    expect(render(mac)).toContain("Setup for me");
    const windows = render({ ...mac, platform: "windows", gitInstalled: true });
    expect(windows).toContain("Install GitHub CLI");
    expect(windows).toContain("Setup for me");
    expect(windows).toContain("Workstation");
    expect(windows).not.toContain("Command Line Tools");
  });

  it("waits for Apple's installer before showing GitHub sign-in", () => {
    expect(render({ ...mac, githubCliInstalled: true }, true)).toContain(
      "Cantrip will check for Git automatically.",
    );
    const installed = render({
      ...mac,
      gitInstalled: true,
      githubCliInstalled: true,
    });
    expect(installed).toContain("Sign in to GitHub on the worker");
    expect(installed).toContain(mac.signInCommand);
    expect(installed).toContain("Check again");
    expect(installed).not.toContain("Setup for me");
  });

  it("keeps manual setup on other platforms and sign-in on older workers", () => {
    expect(render({ ...mac, platform: "other" })).not.toContain("Setup for me");
    expect(render()).toContain("gh auth login");
  });
});
