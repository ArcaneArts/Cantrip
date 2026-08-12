import { projectSummarySchema, workerSummarySchema } from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ProjectReplicaSettings,
  canonicalReplicaRevision,
  projectReplicaForWorker,
} from "./project-replica-settings";

const now = "2026-08-11T20:00:00.000Z";
const revision = "a".repeat(40);
const replica = {
  id: "replica-one",
  projectId: "project-one",
  workerId: "worker-one",
  workerName: "Desk Mac",
  workerOnline: true,
  path: "/srv/cantrip",
  displayPath: "~/Cantrip",
  repositoryFingerprint: "github.com/ArcaneArts/Cantrip",
  primaryWorktreeId: "primary:replica-one",
  branch: "main",
  head: revision,
  dirty: false,
  ready: true,
  worktreeCount: 1,
  lastObservedAt: now,
  createdAt: now,
  updatedAt: now,
};
const project = projectSummarySchema.parse({
  id: "project-one",
  name: "Cantrip",
  position: 0,
  setupStatus: "ready",
  setupError: null,
  worktreePolicy: "agent-managed",
  preferredWorkerId: "worker-one",
  github: {
    repositoryId: "repository-one",
    nameWithOwner: "ArcaneArts/Cantrip",
    url: "https://github.com/ArcaneArts/Cantrip",
  },
  source: {
    id: replica.id,
    workerId: replica.workerId,
    path: replica.path,
    displayPath: replica.displayPath,
  },
  replicas: [replica],
  createdAt: now,
  updatedAt: now,
});
const worker = workerSummarySchema.parse({
  workerId: "worker-one",
  name: "Desk Mac",
  platform: "darwin",
  architecture: "arm64",
  codexVersion: "0.146.1",
  projectReplicas: {
    provision: true,
    synchronize: true,
    remove: true,
    exactRevision: true,
  },
  startedAt: now,
  online: true,
  lastSeenAt: now,
});

describe("project replica settings", () => {
  it("selects the canonical replica revision and maps replicas to workers", () => {
    expect(canonicalReplicaRevision(project)).toBe(revision);
    expect(projectReplicaForWorker(project.replicas, worker.workerId)?.id).toBe(
      replica.id,
    );
    expect(projectReplicaForWorker(project.replicas, "worker-two")).toBeNull();
  });

  it("renders flat project placement and replica controls", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <ProjectReplicaSettings project={project} workers={[worker]} />
      </QueryClientProvider>,
    );

    expect(markup).toContain("Project placement");
    expect(markup).toContain("Worker replicas");
    expect(markup).toContain("Desk Mac");
    expect(markup).toContain("Preferred");
    expect(markup).toContain("Replica capabilities");
    expect(markup).toContain("Last fetch");
    expect(markup).toContain("Sync");
    expect(markup).toContain("Fast-forward Primary");
  });
});
