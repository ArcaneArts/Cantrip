import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  effectivePolicyListSchema,
  policyAssignmentListSchema,
  policyDetailSchema,
  policyListSchema,
  policyTemplateDetailSchema,
  policyTemplateListSchema,
} from "@cantrip/protocol/policies";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";

import { protectedProjectFields } from "./private-label-fixture.js";

const dataDirectory = await mkdtemp(path.join(tmpdir(), "cantrip-policy-api-"));
const config: ServerConfig = {
  agentModel: "gemma4:26b",
  agentModelProvider: "ollama",
  appOrigins: ["http://127.0.0.1:5173"],
  authMode: "none",
  bootstrapMode: "pnpm-dev",
  dataDirectory,
  deploymentMode: "local",
  host: "127.0.0.1",
  ollamaBaseUrl: "http://127.0.0.1:11434/v1",
  port: 4310,
  workerToken: "test-worker-token",
};

let app: Awaited<ReturnType<typeof buildApp>>;
let database: DatabaseConnection;

beforeAll(async () => {
  database = await connectDatabase(config);
  app = await buildApp({ config, database, logger: false });
});

afterAll(async () => {
  await app?.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

describe.sequential("policy API", () => {
  it("lists body-free templates and policies while exposing bounded details", async () => {
    const templatesResponse = await app.inject({
      method: "GET",
      url: "/api/policy-templates",
    });
    expect(templatesResponse.statusCode).toBe(200);
    const templates = policyTemplateListSchema.parse(templatesResponse.json());
    expect(templates).toHaveLength(2);
    expect(templates).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ bodyMarkdown: expect.anything() }),
      ]),
    );

    const templateResponse = await app.inject({
      method: "GET",
      url: "/api/policy-templates/manual-change-protocol",
    });
    expect(templateResponse.statusCode).toBe(200);
    expect(
      policyTemplateDetailSchema.parse(templateResponse.json()).bodyMarkdown,
    ).toContain("# Manual Change Protocol");

    const policiesResponse = await app.inject({
      method: "GET",
      url: "/api/policies",
    });
    expect(policiesResponse.statusCode).toBe(200);
    const policies = policyListSchema.parse(policiesResponse.json());
    expect(policies.policies).toHaveLength(2);
    expect(policies.policies[0]).not.toHaveProperty("bodyMarkdown");

    const detailResponse = await app.inject({
      method: "GET",
      url: `/api/policies/${policies.policies[0]!.id}`,
    });
    expect(detailResponse.statusCode).toBe(200);
    expect(
      policyDetailSchema.parse(detailResponse.json()).bodyMarkdown,
    ).toContain("# Manual Change Protocol");
  });

  it("creates, edits, orders, and rejects stale root mutations", async () => {
    const createdResponse = await app.inject({
      method: "POST",
      url: "/api/policies",
      payload: {
        key: "review-policy",
        name: "Review policy",
        summary: "Review every change before delivery.",
        bodyMarkdown: "# Review policy\n\nInspect the final diff.",
        enabled: true,
        mandatory: false,
      },
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = policyDetailSchema.parse(createdResponse.json());

    const duplicateResponse = await app.inject({
      method: "POST",
      url: "/api/policies",
      payload: {
        key: "review-policy",
        name: "Duplicate",
        summary: "Duplicate key.",
        bodyMarkdown: "# Duplicate",
      },
    });
    expect(duplicateResponse.statusCode).toBe(409);

    const updatedResponse = await app.inject({
      method: "PATCH",
      url: `/api/policies/${created.id}`,
      payload: { rowVersion: created.rowVersion, mandatory: true },
    });
    expect(updatedResponse.statusCode).toBe(200);
    const updated = policyDetailSchema.parse(updatedResponse.json());
    expect(updated.mandatory).toBe(true);

    const customResetResponse = await app.inject({
      method: "POST",
      url: `/api/policies/${created.id}/reset-template`,
      payload: { rowVersion: updated.rowVersion },
    });
    expect(customResetResponse.statusCode).toBe(404);

    const staleResponse = await app.inject({
      method: "PATCH",
      url: `/api/policies/${created.id}`,
      payload: { rowVersion: created.rowVersion, enabled: false },
    });
    expect(staleResponse.statusCode).toBe(409);

    const currentResponse = await app.inject({
      method: "GET",
      url: "/api/policies",
    });
    const current = policyListSchema.parse(currentResponse.json());
    const reversed = [...current.policies].reverse().map(({ id }) => id);
    const orderResponse = await app.inject({
      method: "PATCH",
      url: "/api/policies/order",
      payload: {
        collectionVersion: current.collectionVersion,
        policyIds: reversed,
      },
    });
    expect(orderResponse.statusCode).toBe(200);
    expect(
      policyListSchema.parse(orderResponse.json()).policies.map(({ id }) => id),
    ).toEqual(reversed);

    const staleOrderResponse = await app.inject({
      method: "PATCH",
      url: "/api/policies/order",
      payload: {
        collectionVersion: current.collectionVersion,
        policyIds: reversed,
      },
    });
    expect(staleOrderResponse.statusCode).toBe(409);
  });

  it("copies, resets, and deletes template policies without changing the catalog", async () => {
    const copyResponse = await app.inject({
      method: "POST",
      url: "/api/policies/from-template/manual-change-protocol",
      payload: { key: "manual-change-protocol-copy", mandatory: false },
    });
    expect(copyResponse.statusCode).toBe(201);
    const copy = policyDetailSchema.parse(copyResponse.json());
    expect(copy.templateKey).toBe("manual-change-protocol");

    const editedResponse = await app.inject({
      method: "PATCH",
      url: `/api/policies/${copy.id}`,
      payload: {
        rowVersion: copy.rowVersion,
        name: "Edited copy",
        bodyMarkdown: "# Edited",
        enabled: false,
      },
    });
    const edited = policyDetailSchema.parse(editedResponse.json());
    const resetResponse = await app.inject({
      method: "POST",
      url: `/api/policies/${copy.id}/reset-template`,
      payload: { rowVersion: edited.rowVersion },
    });
    expect(resetResponse.statusCode).toBe(200);
    const reset = policyDetailSchema.parse(resetResponse.json());
    expect(reset.name).toBe("Manual Change Protocol");
    expect(reset.bodyMarkdown).toContain("# Manual Change Protocol");
    expect(reset.enabled).toBe(false);
    expect(reset.mandatory).toBe(false);

    const staleDeleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/policies/${copy.id}`,
      payload: { rowVersion: edited.rowVersion },
    });
    expect(staleDeleteResponse.statusCode).toBe(409);
    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/policies/${copy.id}`,
      payload: { rowVersion: reset.rowVersion },
    });
    expect(deleteResponse.statusCode).toBe(204);

    const templateResponse = await app.inject({
      method: "GET",
      url: "/api/policy-templates/manual-change-protocol",
    });
    expect(templateResponse.statusCode).toBe(200);
  });

  it("returns bounded not-found and validation errors", async () => {
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/policy-templates/missing",
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/policies",
          payload: { key: "INVALID" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/api/policies/missing",
          payload: { rowVersion: 1 },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("assigns workspace and project policies and resolves membership sources", async () => {
    const workspace = await database.repository.createProjectWorkspace(
      LOCAL_USER_ID,
      { name: "Policy workspace" },
    );
    const project = await database.repository.createGithubProject(
      LOCAL_USER_ID,
      {
        workerId: "policy-api-worker",
        ...protectedProjectFields(),
        repositoryId: "policy-api-project",
        nameWithOwner: "ArcaneArts/PolicyApiProject",
        url: "https://github.com/ArcaneArts/PolicyApiProject",
        workspaceIds: [workspace.id],
      },
    );
    const createdResponse = await app.inject({
      method: "POST",
      url: "/api/policies",
      payload: {
        key: "assignment-policy",
        name: "Assignment policy",
        summary: "Apply only where this policy is assigned.",
        bodyMarkdown: "# Assignment policy",
        enabled: true,
        mandatory: false,
      },
    });
    const policy = policyDetailSchema.parse(createdResponse.json());

    const workspaceState = policyAssignmentListSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/workspaces/${workspace.id}/policies`,
        })
      ).json(),
    );
    const workspaceUpdate = await app.inject({
      method: "PATCH",
      url: `/api/workspaces/${workspace.id}/policies`,
      payload: {
        collectionVersion: workspaceState.collectionVersion,
        policyIds: [policy.id],
      },
    });
    expect(workspaceUpdate.statusCode).toBe(200);
    expect(
      policyAssignmentListSchema.parse(workspaceUpdate.json()).directPolicyIds,
    ).toEqual([policy.id]);

    const projectState = policyAssignmentListSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${project.id}/policies`,
        })
      ).json(),
    );
    const projectUpdate = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}/policies`,
      payload: {
        collectionVersion: projectState.collectionVersion,
        policyIds: [policy.id],
      },
    });
    expect(projectUpdate.statusCode).toBe(200);

    const effectiveResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/effective-policies`,
    });
    expect(effectiveResponse.statusCode).toBe(200);
    const effective = effectivePolicyListSchema.parse(effectiveResponse.json());
    expect(
      effective.policies.find(({ key }) => key === policy.key)?.sources,
    ).toEqual([
      {
        type: "workspace",
        workspaceId: workspace.id,
      },
      { type: "project", projectId: project.id },
    ]);

    const staleUpdate = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}/policies`,
      payload: {
        collectionVersion: projectState.collectionVersion,
        policyIds: [],
      },
    });
    expect(staleUpdate.statusCode).toBe(409);

    const workspaceMembershipUpdate = await app.inject({
      method: "PATCH",
      url: `/api/workspaces/${workspace.id}`,
      payload: { expectedRevision: workspace.revision, projectIds: [] },
    });
    expect(workspaceMembershipUpdate.statusCode).toBe(200);
    const afterMembership = effectivePolicyListSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${project.id}/effective-policies`,
        })
      ).json(),
    );
    expect(
      afterMembership.policies.find(({ key }) => key === policy.key)?.sources,
    ).toEqual([{ type: "project", projectId: project.id }]);

    for (const path of [
      "/api/projects/missing/policies",
      "/api/projects/missing/effective-policies",
      "/api/workspaces/missing/policies",
    ]) {
      expect((await app.inject({ method: "GET", url: path })).statusCode).toBe(
        404,
      );
    }
  });
});
