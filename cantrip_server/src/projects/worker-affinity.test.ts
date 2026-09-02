import type { ProjectSummary } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import { projectAllowsExecutionOnWorker } from "./worker-affinity.js";

const project = {
  originKind: "managed-folder",
  capabilities: {
    git: true,
    github: false,
    worktrees: false,
    replicas: false,
    relocation: false,
  },
  preferredWorkerId: "home-worker",
  source: { workerId: "home-worker" },
  replicas: [
    { workerId: "home-worker", ready: true },
    { workerId: "replica-worker", ready: true },
    { workerId: "preparing-worker", ready: false },
  ],
} as ProjectSummary;

describe("project worker affinity", () => {
  it("keeps plain folders on their owning worker", () => {
    const folder = {
      ...project,
      capabilities: { ...project.capabilities, git: false },
    };
    expect(projectAllowsExecutionOnWorker(folder, "home-worker")).toBe(true);
    expect(projectAllowsExecutionOnWorker(folder, "replica-worker")).toBe(
      false,
    );
  });

  it("allows local Git projects only where a ready source exists", () => {
    expect(projectAllowsExecutionOnWorker(project, "home-worker")).toBe(true);
    expect(projectAllowsExecutionOnWorker(project, "replica-worker")).toBe(
      true,
    );
    expect(projectAllowsExecutionOnWorker(project, "preparing-worker")).toBe(
      false,
    );
    expect(projectAllowsExecutionOnWorker(project, "unattached-worker")).toBe(
      false,
    );
  });

  it("keeps GitHub projects portable", () => {
    const github = {
      ...project,
      originKind: "github" as const,
    };
    expect(projectAllowsExecutionOnWorker(github, "unattached-worker")).toBe(
      true,
    );
  });
});
