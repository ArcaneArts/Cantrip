import {
  effectivePolicyWireListSchema,
  encryptedPolicyBootstrapSchema,
  encryptedPolicyCreateSchema,
  encryptedPolicyUpdateSchema,
  policyAssignmentUpdateSchema,
  policyAssignmentWireListSchema,
  policyDeleteSchema,
  policyOrderUpdateSchema,
  policyTemplateDetailSchema,
  policyTemplateListSchema,
  policyWireDetailSchema,
  policyWireListSchema,
} from "@cantrip/protocol/policies";
import type { FastifyInstance } from "fastify";

import {
  PolicyConflictError,
  PolicyScopeNotFoundError,
} from "../../db/policies.js";
import type { ServerRepository } from "../../db/repository.js";
import { errorMessage, invalidBody } from "../../http/request-helpers.js";

export interface PolicyRouteDependencies {
  applicationOwnerId: () => string;
  repository: ServerRepository;
}

export function installPolicyRoutes(
  app: FastifyInstance,
  { applicationOwnerId, repository }: PolicyRouteDependencies,
): void {
  app.get("/api/policy-templates", async (_request, reply) =>
    reply.send(
      policyTemplateListSchema.parse(repository.policies.listTemplates()),
    ),
  );

  app.get<{ Params: { templateKey: string } }>(
    "/api/policy-templates/:templateKey",
    async (request, reply) => {
      const template = repository.policies.getTemplate(
        request.params.templateKey,
      );
      return template
        ? reply.send(policyTemplateDetailSchema.parse(template))
        : reply.code(404).send({ error: "Policy template not found." });
    },
  );

  app.get("/api/policies", async (_request, reply) =>
    reply.send(
      policyWireListSchema.parse(
        await repository.policies.list(applicationOwnerId()),
      ),
    ),
  );

  app.post("/api/policies/bootstrap", async (request, reply) => {
    const input = encryptedPolicyBootstrapSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    try {
      return reply.send(
        policyWireListSchema.parse(
          await repository.policies.bootstrap(applicationOwnerId(), input.data),
        ),
      );
    } catch (error) {
      const status = error instanceof PolicyConflictError ? 409 : 500;
      return reply.code(status).send({ error: errorMessage(error) });
    }
  });

  app.post("/api/policies", async (request, reply) => {
    const input = encryptedPolicyCreateSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    try {
      const policy = await repository.policies.create(
        applicationOwnerId(),
        input.data,
      );
      return reply.code(201).send(policyWireDetailSchema.parse(policy));
    } catch (error) {
      const status = error instanceof PolicyConflictError ? 409 : 500;
      return reply.code(status).send({ error: errorMessage(error) });
    }
  });

  app.patch("/api/policies/order", async (request, reply) => {
    const input = policyOrderUpdateSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    try {
      const policies = await repository.policies.reorder(
        applicationOwnerId(),
        input.data,
      );
      return reply.send(policyWireListSchema.parse(policies));
    } catch (error) {
      const status = error instanceof PolicyConflictError ? 409 : 500;
      return reply.code(status).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Params: { policyId: string } }>(
    "/api/policies/:policyId",
    async (request, reply) => {
      const policy = await repository.policies.get(
        applicationOwnerId(),
        request.params.policyId,
      );
      return policy
        ? reply.send(policyWireDetailSchema.parse(policy))
        : reply.code(404).send({ error: "Policy not found." });
    },
  );

  app.patch<{ Params: { policyId: string } }>(
    "/api/policies/:policyId",
    async (request, reply) => {
      const input = encryptedPolicyUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const policy = await repository.policies.update(
          applicationOwnerId(),
          request.params.policyId,
          input.data,
        );
        return policy
          ? reply.send(policyWireDetailSchema.parse(policy))
          : reply.code(404).send({ error: "Policy not found." });
      } catch (error) {
        const status = error instanceof PolicyConflictError ? 409 : 500;
        return reply.code(status).send({ error: errorMessage(error) });
      }
    },
  );

  app.delete<{ Params: { policyId: string } }>(
    "/api/policies/:policyId",
    async (request, reply) => {
      const input = policyDeleteSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        return (await repository.policies.delete(
          applicationOwnerId(),
          request.params.policyId,
          input.data.rowVersion,
        ))
          ? reply.code(204).send()
          : reply.code(404).send({ error: "Policy not found." });
      } catch (error) {
        const status = error instanceof PolicyConflictError ? 409 : 500;
        return reply.code(status).send({ error: errorMessage(error) });
      }
    },
  );

  app.get<{ Params: { workspaceId: string } }>(
    "/api/workspaces/:workspaceId/policies",
    async (request, reply) => {
      const assignments = await repository.policies.listWorkspaceAssignments(
        applicationOwnerId(),
        request.params.workspaceId,
      );
      return assignments
        ? reply.send(policyAssignmentWireListSchema.parse(assignments))
        : reply.code(404).send({ error: "Workspace not found." });
    },
  );

  app.patch<{ Params: { workspaceId: string } }>(
    "/api/workspaces/:workspaceId/policies",
    async (request, reply) => {
      const input = policyAssignmentUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        await repository.policies.replaceWorkspaceAssignments(
          applicationOwnerId(),
          request.params.workspaceId,
          input.data,
        );
        const assignments = await repository.policies.listWorkspaceAssignments(
          applicationOwnerId(),
          request.params.workspaceId,
        );
        return assignments
          ? reply.send(policyAssignmentWireListSchema.parse(assignments))
          : reply.code(404).send({ error: "Workspace not found." });
      } catch (error) {
        const status =
          error instanceof PolicyScopeNotFoundError
            ? 404
            : error instanceof PolicyConflictError
              ? 409
              : 500;
        return reply.code(status).send({ error: errorMessage(error) });
      }
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/policies",
    async (request, reply) => {
      const assignments = await repository.policies.listProjectAssignments(
        applicationOwnerId(),
        request.params.projectId,
      );
      return assignments
        ? reply.send(policyAssignmentWireListSchema.parse(assignments))
        : reply.code(404).send({ error: "Project not found." });
    },
  );

  app.patch<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/policies",
    async (request, reply) => {
      const input = policyAssignmentUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        await repository.policies.replaceProjectAssignments(
          applicationOwnerId(),
          request.params.projectId,
          input.data,
        );
        const assignments = await repository.policies.listProjectAssignments(
          applicationOwnerId(),
          request.params.projectId,
        );
        return assignments
          ? reply.send(policyAssignmentWireListSchema.parse(assignments))
          : reply.code(404).send({ error: "Project not found." });
      } catch (error) {
        const status =
          error instanceof PolicyScopeNotFoundError
            ? 404
            : error instanceof PolicyConflictError
              ? 409
              : 500;
        return reply.code(status).send({ error: errorMessage(error) });
      }
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/effective-policies",
    async (request, reply) => {
      const effective = await repository.policies.resolveEffective(
        applicationOwnerId(),
        request.params.projectId,
      );
      return effective
        ? reply.send(effectivePolicyWireListSchema.parse(effective))
        : reply.code(404).send({ error: "Project not found." });
    },
  );
}
