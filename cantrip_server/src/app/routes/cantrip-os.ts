import { CantripOsWorkspaceOperationCoordinator } from "../../cantrip-os/workspace-operations.js";
import { workspaceOperationSummary } from "../../db/repository/cantrip-os-workspace-operations.js";
import { installCantripOsBackupRoutes } from "./cantrip-os-backups.js";
import { installCantripOsDesktopRoutes } from "./cantrip-os-desktop.js";
import { installCantripOsPowerRoutes } from "./cantrip-os-power.js";
import {
  cantripOsRunDefinitionApiSchema,
  cantripOsAttachSchema,
  cantripOsBindingCreateSchema,
  cantripOsInspectSchema,
  cantripOsProvisionSchema,
  cantripOsWorkspaceCreateSchema,
  cantripOsWorkspaceOperationListQuerySchema,
  cantripOsRecoveryRequestSchema,
} from "@cantrip/protocol";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  CantripOsCoordinator,
  type CantripOsDefinitionLifecycle,
} from "../../cantrip-os/coordinator.js";
import type { ServerRepository } from "../../db/repository.js";
import { CantripOsPlacementError } from "../../db/repository/cantrip-os.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";
import { invalidBody } from "../../http/request-helpers.js";

export function installCantripOsRoutes(
  app: FastifyInstance,
  dependencies: {
    applicationOwnerId: () => string;
    serverId: string;
    definitionLifecycle?: CantripOsDefinitionLifecycle;
    repository: Pick<ServerRepository, "cantripOs" | "getWorker">;
    bridge: Pick<WorkerCommandBus, "request"> &
      Partial<Pick<WorkerCommandBus, "connectionIdentity" | "isConnected">>;
  },
) {
  installCantripOsBackupRoutes(app, dependencies);
  installCantripOsPowerRoutes(app, dependencies);
  installCantripOsDesktopRoutes(app, dependencies);
  const { repository, applicationOwnerId: owner } = dependencies;
  const coordinator = new CantripOsCoordinator(
    repository,
    dependencies.bridge,
    dependencies.serverId,
    dependencies.definitionLifecycle,
  );
  type Params = { Params: Record<string, string> };
  type Request = FastifyRequest<Params>;
  const route =
    (operation: (request: Request) => Promise<unknown>) =>
    async (request: Request, reply: FastifyReply) => {
      try {
        return reply.send(await operation(request));
      } catch (error) {
        return reply.code(409).send({
          error:
            error instanceof CantripOsPlacementError
              ? error.message
              : "CantripOS request failed. Inspect worker diagnostics before retrying a mutation.",
        });
      }
    };
  // Body schemas are shared with the native Server. UID/path/success receipts
  // are deliberately absent from every client admission shape.
  const parsed =
    <T>(
      schema: {
        safeParse(
          value: unknown,
        ):
          | { success: true; data: T }
          | { success: false; error: { issues: unknown } };
      },
      operation: (request: Request, body: T) => Promise<unknown>,
    ) =>
    async (request: Request, reply: FastifyReply) => {
      const input = schema.safeParse(request.body);
      if (!input.success)
        return reply.code(400).send(invalidBody(input.error.issues));
      return route((request) => operation(request, input.data))(request, reply);
    };
  app.get<Params>(
    "/api/cantrip-os",
    route(() => repository.cantripOs.list(owner())),
  );
  app.get<Params>(
    "/api/projects/:projectId/cantrip-os/run-sources",
    route((request) =>
      repository.cantripOs.runSources(owner(), request.params.projectId!),
    ),
  );
  app.post<Params>(
    "/api/projects/:projectId/cantrip-os/bindings/:bindingId/run-definitions",
    parsed(cantripOsRunDefinitionApiSchema, (request, input) =>
      coordinator.runDefinition(
        owner(),
        request.params.projectId!,
        request.params.bindingId!,
        input,
      ),
    ),
  );
  app.post<Params>(
    "/api/cantrip-os/inspect",
    parsed(cantripOsInspectSchema, (_request, input) =>
      coordinator.inspect(owner(), input),
    ),
  );
  app.post<Params>(
    "/api/cantrip-os/attach",
    parsed(cantripOsAttachSchema, (_request, input) =>
      coordinator.attach(owner(), input),
    ),
  );
  app.post<Params>(
    "/api/cantrip-os/:instanceId/recovery",
    parsed(cantripOsRecoveryRequestSchema, (request, input) =>
      coordinator.recoverInstance(owner(), request.params.instanceId!, input),
    ),
  );
  app.post<Params>(
    "/api/cantrip-os/:instanceId/refresh",
    route((request) =>
      coordinator.refresh(owner(), request.params.instanceId!),
    ),
  );
  app.get<Params>(
    "/api/cantrip-os/:instanceId/workspaces",
    route(async (request) => {
      if (
        !(await repository.cantripOs.attachment(
          owner(),
          request.params.instanceId!,
        ))
      )
        throw new CantripOsPlacementError("OS attachment not found.");
      return repository.cantripOs.listWorkspaces(
        owner(),
        request.params.instanceId!,
      );
    }),
  );
  app.post<Params>(
    "/api/cantrip-os/:instanceId/workspaces",
    parsed(cantripOsWorkspaceCreateSchema, (request, input) =>
      coordinator.createWorkspace(owner(), request.params.instanceId!, input),
    ),
  );
  app.get<Params>(
    "/api/cantrip-os/:instanceId/workspace-operations",
    async (request, reply) => {
      const input = cantripOsWorkspaceOperationListQuerySchema.safeParse(
        request.query,
      );
      if (!input.success)
        return reply.code(400).send(invalidBody(input.error.issues));
      return route((request) =>
        repository.cantripOs.workspaceOperations.list(
          owner(),
          request.params.instanceId!,
          input.data,
        ),
      )(request, reply);
    },
  );
  app.get<Params>(
    "/api/cantrip-os/:instanceId/workspace-operations/:operationId",
    route(async (request) => {
      const row = await repository.cantripOs.workspaceOperations.get(
        owner(),
        request.params.instanceId!,
        request.params.operationId!,
      );
      if (!row)
        throw new CantripOsPlacementError("Workspace operation not found.");
      return workspaceOperationSummary(row);
    }),
  );
  app.post<Params>(
    "/api/cantrip-os/:instanceId/workspace-operations/:operationId/observe",
    route((request) =>
      new CantripOsWorkspaceOperationCoordinator(
        repository,
        dependencies.bridge,
        dependencies.serverId,
      ).observe(
        owner(),
        request.params.instanceId!,
        request.params.operationId!,
      ),
    ),
  );
  app.get<Params>(
    "/api/projects/:projectId/cantrip-os/bindings",
    route((request) =>
      repository.cantripOs.listBindings(owner(), request.params.projectId!),
    ),
  );
  app.post<Params>(
    "/api/projects/:projectId/cantrip-os/bindings",
    parsed(cantripOsBindingCreateSchema, (request, input) =>
      coordinator.createBinding(owner(), request.params.projectId!, input),
    ),
  );
  app.post<Params>(
    "/api/projects/:projectId/cantrip-os/bindings/:bindingId/provision",
    parsed(cantripOsProvisionSchema, (request, input) =>
      coordinator.provision(
        owner(),
        request.params.projectId!,
        request.params.bindingId!,
        input,
      ),
    ),
  );
  app.post<Params>(
    "/api/projects/:projectId/cantrip-os/bindings/:bindingId/recover",
    route((request) =>
      coordinator.recover(
        owner(),
        request.params.projectId!,
        request.params.bindingId!,
      ),
    ),
  );
  app.post<Params>(
    "/api/projects/:projectId/cantrip-os/bindings/:bindingId/verify",
    route((request) =>
      coordinator.verify(
        owner(),
        request.params.projectId!,
        request.params.bindingId!,
      ),
    ),
  );
}
