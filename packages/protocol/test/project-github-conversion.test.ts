import { describe, expect, it } from "vitest";

import {
  encryptedProjectGithubConversionPreflightRequestSchema,
  encryptedProjectGithubConversionStartSchema,
  projectGithubConversionPreflightResultSchema,
  workerCommandSchema,
} from "../src/index.js";

const projectId = "019fe8aa-a7a3-7404-8a96-d3be7f0fb338";
const jobId = "019fe8aa-a7a3-7404-8a96-d3be7f0fb339";
const projectSourceId = "019fe8aa-a7a3-7404-8a96-d3be7f0fb340";
const workerId = "worker-one";
const repository = {
  repositoryId: `ctrr_${"r".repeat(43)}`,
  nameWithOwner: `ctrr_${"n".repeat(43)}`,
  url: `ctrr_${"u".repeat(43)}`,
};
const sourcePath = `ctrr_${"p".repeat(43)}`;
const sourceDisplayPath = `ctrr_${"d".repeat(43)}`;

describe("project GitHub conversion protocol", () => {
  it("carries protected external source paths on preflight and execution", () => {
    expect(
      workerCommandSchema.parse({
        type: "project.folder-conversion.preflight",
        projectId,
        repository,
        sourcePath,
        sourceDisplayPath,
      }),
    ).toMatchObject({ sourcePath, sourceDisplayPath });
    expect(
      workerCommandSchema.parse({
        type: "project.folder-conversion.execute",
        jobId,
        attempt: 1,
        projectId,
        repository,
        sourcePath,
        sourceDisplayPath,
        confirmationToken: "a".repeat(64),
        initialCommit: null,
      }),
    ).toMatchObject({ sourcePath, sourceDisplayPath });
    expect(
      workerCommandSchema.safeParse({
        type: "project.folder-conversion.preflight",
        projectId,
        repository,
        sourcePath,
      }).success,
    ).toBe(false);
  });

  it("distinguishes pushing an empty repository from linking matching history", () => {
    const result = projectGithubConversionPreflightResultSchema.parse({
      status: "ready",
      projectId,
      projectSourceId,
      workerId,
      repository,
      confirmationToken: "a".repeat(64),
      localState: "committed",
      branch: "main",
      head: "b".repeat(40),
      dirty: false,
      originUrl: `ctrr_${"o".repeat(43)}`,
      remoteAction: "link",
      requiresInitialCommit: false,
      warnings: [],
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("unexpected blocked result");
    expect(result.remoteAction).toBe("link");
  });

  it("binds encrypted preflight and start requests to one project source", () => {
    const base = {
      repository,
      repositoryBlindIndex: Buffer.alloc(32, 7).toString("base64url"),
      projectSourceId,
      workerId,
    };
    expect(
      encryptedProjectGithubConversionPreflightRequestSchema.parse(base),
    ).toMatchObject({ projectSourceId, workerId });
    expect(
      encryptedProjectGithubConversionStartSchema.parse({
        ...base,
        confirmationToken: "a".repeat(64),
        initialCommit: null,
      }),
    ).toMatchObject({ projectSourceId, workerId });
    expect(
      encryptedProjectGithubConversionStartSchema.safeParse({
        ...base,
        workerId: undefined,
        confirmationToken: "a".repeat(64),
        initialCommit: null,
      }).success,
    ).toBe(false);
  });
});
