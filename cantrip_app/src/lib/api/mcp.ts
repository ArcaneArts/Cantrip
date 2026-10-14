import {
  openMcpServerWireList,
  openDiscoveredMcpServerCreate,
  openMcpServerWireSummary,
  protectMcpServerCreate,
  protectMcpServerUpdate,
} from "@/lib/protected-secrets";
import { request, post } from "@/lib/api-client";
import {
  mcpServerDiscoveryResultSchema,
  mcpServerCopySchema,
} from "@cantrip/protocol";
import type {
  EncryptedMcpServerCreate,
  McpServerConfiguration,
  ResourceAudience,
  McpServerCopy,
} from "@cantrip/protocol";

export async function getGlobalMcpServers() {
  return openMcpServerWireList(await request("/api/settings/mcp-servers"));
}

export async function discoverGlobalMcpServers(workerId: string) {
  const discovered = mcpServerDiscoveryResultSchema.parse(
    await request(
      `/api/settings/mcp-discovery/${encodeURIComponent(workerId)}`,
    ),
  );
  return {
    ...discovered,
    candidates: await Promise.all(
      discovered.candidates.map(async (candidate) => ({
        source: candidate.source,
        sourceScope: candidate.sourceScope,
        ...(await openDiscoveredMcpServerCreate(candidate.configuration)),
      })),
    ),
  };
}

export async function addGlobalDiscoveredMcpServer(
  input: EncryptedMcpServerCreate,
) {
  return openMcpServerWireSummary(
    await post("/api/settings/mcp-servers", input),
  );
}

export async function createGlobalMcpServer(
  input: McpServerConfiguration,
  workerId: string | null = null,
  audience: ResourceAudience = "ide",
) {
  return openMcpServerWireSummary(
    await post(
      "/api/settings/mcp-servers",
      await protectMcpServerCreate(input, workerId, {}, audience),
    ),
  );
}

export async function updateGlobalMcpServer(
  serverId: string,
  input: McpServerConfiguration,
  workerId: string | null = null,
  audience?: ResourceAudience,
) {
  return openMcpServerWireSummary(
    await request(`/api/settings/mcp-servers/${encodeURIComponent(serverId)}`, {
      method: "PUT",
      body: JSON.stringify(
        await protectMcpServerUpdate(serverId, input, workerId, {}, audience),
      ),
    }),
  );
}

export async function deleteGlobalMcpServer(serverId: string) {
  await request(`/api/settings/mcp-servers/${encodeURIComponent(serverId)}`, {
    method: "DELETE",
  });
}

export async function getProjectMcpServers(projectId: string) {
  return openMcpServerWireList(
    await request(`/api/projects/${encodeURIComponent(projectId)}/mcp-servers`),
  );
}

export async function discoverProjectMcpServers(
  projectId: string,
  workerId: string,
) {
  const discovered = mcpServerDiscoveryResultSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/mcp-discovery/${encodeURIComponent(workerId)}`,
    ),
  );
  return {
    ...discovered,
    candidates: await Promise.all(
      discovered.candidates.map(async (candidate) => ({
        source: candidate.source,
        sourceScope: candidate.sourceScope,
        ...(await openDiscoveredMcpServerCreate(candidate.configuration)),
      })),
    ),
  };
}

export async function addProjectDiscoveredMcpServer(
  projectId: string,
  input: EncryptedMcpServerCreate,
) {
  return openMcpServerWireSummary(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/mcp-servers`,
      input,
    ),
  );
}

export async function createProjectMcpServer(
  projectId: string,
  input: McpServerConfiguration,
  workerId: string | null = null,
  audience: ResourceAudience = "ide",
) {
  return openMcpServerWireSummary(
    await post(
      `/api/projects/${encodeURIComponent(projectId)}/mcp-servers`,
      await protectMcpServerCreate(input, workerId, {}, audience),
    ),
  );
}

export async function updateProjectMcpServer(
  projectId: string,
  serverId: string,
  input: McpServerConfiguration,
  workerId: string | null = null,
  audience?: ResourceAudience,
) {
  return openMcpServerWireSummary(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/mcp-servers/${encodeURIComponent(serverId)}`,
      {
        method: "PUT",
        body: JSON.stringify(
          await protectMcpServerUpdate(serverId, input, workerId, {}, audience),
        ),
      },
    ),
  );
}

export async function deleteProjectMcpServer(
  projectId: string,
  serverId: string,
) {
  await request(
    `/api/projects/${encodeURIComponent(projectId)}/mcp-servers/${encodeURIComponent(serverId)}`,
    { method: "DELETE" },
  );
}

export async function copyProjectMcpServer(
  projectId: string,
  input: McpServerCopy,
) {
  const copy = mcpServerCopySchema.parse(input);
  const source = (await getProjectMcpServers(copy.sourceProjectId)).find(
    ({ id }) => id === copy.sourceServerId,
  );
  if (!source) throw new Error("Source MCP server was not found.");
  const {
    id: _id,
    scope: _scope,
    projectId: _projectId,
    workerId: _workerId,
    audience,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...configuration
  } = source;
  return createProjectMcpServer(
    projectId,
    configuration,
    source.workerId,
    audience,
  );
}
