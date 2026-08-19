import { randomUUID } from "node:crypto";

import {
  EFFECTIVE_POLICY_LIMIT,
  POLICY_LIMIT,
  effectivePolicyListSchema,
  policyAssignmentListSchema,
  policyAssignmentUpdateSchema,
  policyCreateSchema,
  policyDetailSchema,
  policyListSchema,
  policyOrderUpdateSchema,
  policySummarySchema,
  policyTemplateResetSchema,
  policyUpdateSchema,
  type EffectivePolicyList,
  type EffectivePolicySource,
  type PolicyAssignmentList,
  type PolicyAssignmentUpdate,
  type PolicyCreate,
  type PolicyDetail,
  type PolicyList,
  type PolicyOrderUpdate,
  type PolicySummary,
  type PolicyTemplateReset,
  type PolicyUpdate,
} from "@cantrip/protocol/policies";
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";

import {
  getPackagedPolicyTemplate,
  listPackagedPolicyTemplates,
  requirePackagedPolicyTemplate,
} from "../policies/templates.js";
import * as schema from "./schema.js";

const POLICY_BOOTSTRAP_VERSION = 1;

type PolicyDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;
type PolicyTransaction = Parameters<
  Parameters<PolicyDatabase["transaction"]>[0]
>[0];
type PolicyRow = typeof schema.policies.$inferSelect;

export class PolicyConflictError extends Error {
  constructor(
    message: string,
    readonly code:
      | "collection-changed"
      | "duplicate-key"
      | "invalid-order"
      | "limit-exceeded"
      | "stale-version",
  ) {
    super(message);
  }
}

export class PolicyScopeNotFoundError extends Error {}

function toISOString(value: Date): string {
  return value.toISOString();
}

function isUniqueViolation(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current = error;
  while (current && !visited.has(current)) {
    visited.add(current);
    if (typeof current !== "object") break;
    if ("code" in current && current.code === "23505") return true;
    if (
      current instanceof Error &&
      /duplicate key|unique constraint/iu.test(current.message)
    ) {
      return true;
    }
    current = "cause" in current ? current.cause : null;
  }
  return false;
}

function toPolicySummary(
  row: PolicyRow,
  workspaceAssignmentCount: number,
  projectAssignmentCount: number,
): PolicySummary {
  return policySummarySchema.parse({
    id: row.id,
    key: row.key,
    name: row.name,
    summary: row.summary,
    enabled: row.enabled,
    mandatory: row.mandatory,
    position: row.position,
    templateKey: row.templateKey,
    rowVersion: row.rowVersion,
    workspaceAssignmentCount,
    projectAssignmentCount,
    createdAt: toISOString(row.createdAt),
    updatedAt: toISOString(row.updatedAt),
  });
}

function toPolicyDetail(
  row: PolicyRow,
  workspaceAssignmentCount: number,
  projectAssignmentCount: number,
): PolicyDetail {
  return policyDetailSchema.parse({
    ...toPolicySummary(row, workspaceAssignmentCount, projectAssignmentCount),
    bodyMarkdown: row.bodyMarkdown,
  });
}

export class PolicyRepository {
  constructor(private readonly database: PolicyDatabase) {}

  listTemplates() {
    return listPackagedPolicyTemplates();
  }

  getTemplate(templateKey: string) {
    return getPackagedPolicyTemplate(templateKey);
  }

  async ensureBootstrap(ownerId: string): Promise<boolean> {
    const current = await this.database
      .select({ bootstrapVersion: schema.policyOwnerStates.bootstrapVersion })
      .from(schema.policyOwnerStates)
      .where(eq(schema.policyOwnerStates.ownerId, ownerId))
      .limit(1);
    if (current[0] && current[0].bootstrapVersion >= POLICY_BOOTSTRAP_VERSION) {
      return false;
    }
    const template = requirePackagedPolicyTemplate("manual-change-protocol");
    return this.database.transaction(async (transaction) => {
      await transaction
        .insert(schema.policyOwnerStates)
        .values({ ownerId })
        .onConflictDoNothing();
      const now = new Date();
      const claimed = await transaction
        .update(schema.policyOwnerStates)
        .set({ bootstrapVersion: POLICY_BOOTSTRAP_VERSION, updatedAt: now })
        .where(
          and(
            eq(schema.policyOwnerStates.ownerId, ownerId),
            eq(schema.policyOwnerStates.bootstrapVersion, 0),
          ),
        )
        .returning({ ownerId: schema.policyOwnerStates.ownerId });
      if (!claimed[0]) return false;

      await transaction
        .insert(schema.policies)
        .values({
          id: randomUUID(),
          ownerId,
          key: template.suggestedPolicyKey,
          name: template.name,
          summary: template.summary,
          bodyMarkdown: template.bodyMarkdown,
          enabled: template.suggestedEnabled,
          mandatory: template.suggestedMandatory,
          position: 0,
          templateKey: template.templateKey,
          rowVersion: 1,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({
          target: [schema.policies.ownerId, schema.policies.key],
        });
      return true;
    });
  }

  async ensureAllOwnersBootstrapped(): Promise<number> {
    const [owners, states] = await Promise.all([
      this.database.select({ id: schema.users.id }).from(schema.users),
      this.database
        .select({
          ownerId: schema.policyOwnerStates.ownerId,
          bootstrapVersion: schema.policyOwnerStates.bootstrapVersion,
        })
        .from(schema.policyOwnerStates),
    ]);
    const bootstrappedOwners = new Set(
      states.flatMap(({ bootstrapVersion, ownerId }) =>
        bootstrapVersion >= POLICY_BOOTSTRAP_VERSION ? [ownerId] : [],
      ),
    );
    let bootstrapped = 0;
    for (const owner of owners) {
      if (bootstrappedOwners.has(owner.id)) continue;
      if (await this.ensureBootstrap(owner.id)) bootstrapped += 1;
    }
    return bootstrapped;
  }

  async list(ownerId: string): Promise<PolicyList> {
    await this.ensureBootstrap(ownerId);
    const [stateRows, policyRows, workspaceCounts, projectCounts] =
      await Promise.all([
        this.database
          .select({
            collectionVersion: schema.policyOwnerStates.collectionVersion,
          })
          .from(schema.policyOwnerStates)
          .where(eq(schema.policyOwnerStates.ownerId, ownerId))
          .limit(1),
        this.database
          .select()
          .from(schema.policies)
          .where(eq(schema.policies.ownerId, ownerId))
          .orderBy(asc(schema.policies.position), asc(schema.policies.key)),
        this.database
          .select({
            policyId: schema.workspacePolicyAssignments.policyId,
            value: count(),
          })
          .from(schema.workspacePolicyAssignments)
          .innerJoin(
            schema.policies,
            and(
              eq(
                schema.policies.id,
                schema.workspacePolicyAssignments.policyId,
              ),
              eq(schema.policies.ownerId, ownerId),
            ),
          )
          .groupBy(schema.workspacePolicyAssignments.policyId),
        this.database
          .select({
            policyId: schema.projectPolicyAssignments.policyId,
            value: count(),
          })
          .from(schema.projectPolicyAssignments)
          .innerJoin(
            schema.policies,
            and(
              eq(schema.policies.id, schema.projectPolicyAssignments.policyId),
              eq(schema.policies.ownerId, ownerId),
            ),
          )
          .groupBy(schema.projectPolicyAssignments.policyId),
      ]);
    const workspaceCountByPolicy = new Map(
      workspaceCounts.map(({ policyId, value }) => [policyId, value]),
    );
    const projectCountByPolicy = new Map(
      projectCounts.map(({ policyId, value }) => [policyId, value]),
    );
    return policyListSchema.parse({
      collectionVersion: stateRows[0]?.collectionVersion ?? 1,
      policies: policyRows.map((row) =>
        toPolicySummary(
          row,
          workspaceCountByPolicy.get(row.id) ?? 0,
          projectCountByPolicy.get(row.id) ?? 0,
        ),
      ),
    });
  }

  async get(ownerId: string, policyId: string): Promise<PolicyDetail | null> {
    await this.ensureBootstrap(ownerId);
    const rows = await this.database
      .select()
      .from(schema.policies)
      .where(
        and(
          eq(schema.policies.id, policyId),
          eq(schema.policies.ownerId, ownerId),
        ),
      )
      .limit(1);
    return rows[0] ? this.detail(rows[0]) : null;
  }

  async getByKey(
    ownerId: string,
    policyKey: string,
  ): Promise<PolicyDetail | null> {
    await this.ensureBootstrap(ownerId);
    const rows = await this.database
      .select()
      .from(schema.policies)
      .where(
        and(
          eq(schema.policies.key, policyKey),
          eq(schema.policies.ownerId, ownerId),
        ),
      )
      .limit(1);
    return rows[0] ? this.detail(rows[0]) : null;
  }

  async create(
    ownerId: string,
    rawInput: PolicyCreate,
    templateKey: string | null = null,
  ): Promise<PolicyDetail> {
    const input = policyCreateSchema.parse(rawInput);
    await this.ensureBootstrap(ownerId);
    try {
      const row = await this.database.transaction(async (transaction) => {
        await this.incrementCollectionVersion(transaction, ownerId);
        const totals = await transaction
          .select({ value: count() })
          .from(schema.policies)
          .where(eq(schema.policies.ownerId, ownerId));
        if ((totals[0]?.value ?? 0) >= POLICY_LIMIT) {
          throw new PolicyConflictError(
            `An owner cannot store more than ${POLICY_LIMIT} policies.`,
            "limit-exceeded",
          );
        }
        const positions = await transaction
          .select({ position: schema.policies.position })
          .from(schema.policies)
          .where(eq(schema.policies.ownerId, ownerId))
          .orderBy(sql`${schema.policies.position} DESC`)
          .limit(1);
        const now = new Date();
        const rows = await transaction
          .insert(schema.policies)
          .values({
            id: randomUUID(),
            ownerId,
            ...input,
            position: (positions[0]?.position ?? -1) + 1,
            templateKey,
            rowVersion: 1,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        return rows[0]!;
      });
      return toPolicyDetail(row, 0, 0);
    } catch (error) {
      if (error instanceof PolicyConflictError) throw error;
      if (isUniqueViolation(error)) {
        throw new PolicyConflictError(
          `Policy key ${input.key} is already in use.`,
          "duplicate-key",
        );
      }
      throw error;
    }
  }

  async createFromTemplate(
    ownerId: string,
    templateKey: string,
    overrides: Partial<PolicyCreate> = {},
  ): Promise<PolicyDetail> {
    const template = requirePackagedPolicyTemplate(templateKey);
    return this.create(
      ownerId,
      policyCreateSchema.parse({
        key: template.suggestedPolicyKey,
        name: template.name,
        summary: template.summary,
        bodyMarkdown: template.bodyMarkdown,
        enabled: template.suggestedEnabled,
        mandatory: template.suggestedMandatory,
        ...overrides,
      }),
      template.templateKey,
    );
  }

  async resetFromTemplate(
    ownerId: string,
    policyId: string,
    rawInput: PolicyTemplateReset,
  ): Promise<PolicyDetail | null> {
    const input = policyTemplateResetSchema.parse(rawInput);
    const current = await this.database
      .select()
      .from(schema.policies)
      .where(
        and(
          eq(schema.policies.id, policyId),
          eq(schema.policies.ownerId, ownerId),
        ),
      )
      .limit(1);
    const policy = current[0];
    if (!policy) return null;
    if (!policy.templateKey) {
      throw new PolicyScopeNotFoundError(
        "This policy was not created from a packaged template.",
      );
    }
    const template = getPackagedPolicyTemplate(policy.templateKey);
    if (!template) {
      throw new PolicyScopeNotFoundError("Policy template not found.");
    }
    const rows = await this.database
      .update(schema.policies)
      .set({
        name: template.name,
        summary: template.summary,
        bodyMarkdown: template.bodyMarkdown,
        ...(input.restoreDefaults
          ? {
              enabled: template.suggestedEnabled,
              mandatory: template.suggestedMandatory,
            }
          : {}),
        rowVersion: input.rowVersion + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.policies.id, policyId),
          eq(schema.policies.ownerId, ownerId),
          eq(schema.policies.rowVersion, input.rowVersion),
        ),
      )
      .returning();
    if (rows[0]) return this.detail(rows[0]);
    throw new PolicyConflictError(
      "The policy changed in another session.",
      "stale-version",
    );
  }

  async update(
    ownerId: string,
    policyId: string,
    rawInput: PolicyUpdate,
  ): Promise<PolicyDetail | null> {
    const input = policyUpdateSchema.parse(rawInput);
    const { rowVersion, ...changes } = input;
    const rows = await this.database
      .update(schema.policies)
      .set({ ...changes, rowVersion: rowVersion + 1, updatedAt: new Date() })
      .where(
        and(
          eq(schema.policies.id, policyId),
          eq(schema.policies.ownerId, ownerId),
          eq(schema.policies.rowVersion, rowVersion),
        ),
      )
      .returning();
    if (rows[0]) return this.detail(rows[0]);
    const existing = await this.database
      .select({ rowVersion: schema.policies.rowVersion })
      .from(schema.policies)
      .where(
        and(
          eq(schema.policies.id, policyId),
          eq(schema.policies.ownerId, ownerId),
        ),
      )
      .limit(1);
    if (!existing[0]) return null;
    throw new PolicyConflictError(
      "The policy changed in another session.",
      "stale-version",
    );
  }

  async delete(
    ownerId: string,
    policyId: string,
    rowVersion: number,
  ): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .delete(schema.policies)
        .where(
          and(
            eq(schema.policies.id, policyId),
            eq(schema.policies.ownerId, ownerId),
            eq(schema.policies.rowVersion, rowVersion),
          ),
        )
        .returning({ id: schema.policies.id });
      if (rows[0]) {
        await this.incrementCollectionVersion(transaction, ownerId);
        return true;
      }
      const existing = await transaction
        .select({ id: schema.policies.id })
        .from(schema.policies)
        .where(
          and(
            eq(schema.policies.id, policyId),
            eq(schema.policies.ownerId, ownerId),
          ),
        )
        .limit(1);
      if (!existing[0]) return false;
      throw new PolicyConflictError(
        "The policy changed in another session.",
        "stale-version",
      );
    });
  }

  async reorder(
    ownerId: string,
    rawInput: PolicyOrderUpdate,
  ): Promise<PolicyList> {
    const input = policyOrderUpdateSchema.parse(rawInput);
    await this.database.transaction(async (transaction) => {
      await this.claimCollectionVersion(
        transaction,
        ownerId,
        input.collectionVersion,
      );
      const current = await transaction
        .select({ id: schema.policies.id })
        .from(schema.policies)
        .where(eq(schema.policies.ownerId, ownerId));
      const currentIds = new Set(current.map(({ id }) => id));
      if (
        currentIds.size !== input.policyIds.length ||
        input.policyIds.some((id) => !currentIds.has(id))
      ) {
        throw new PolicyConflictError(
          "Policy order must contain every current policy exactly once.",
          "invalid-order",
        );
      }
      for (const [position, policyId] of input.policyIds.entries()) {
        await transaction
          .update(schema.policies)
          .set({ position, updatedAt: new Date() })
          .where(
            and(
              eq(schema.policies.id, policyId),
              eq(schema.policies.ownerId, ownerId),
            ),
          );
      }
    });
    return this.list(ownerId);
  }

  async replaceProjectAssignments(
    ownerId: string,
    projectId: string,
    rawInput: PolicyAssignmentUpdate,
  ): Promise<number> {
    const input = policyAssignmentUpdateSchema.parse(rawInput);
    return this.replaceAssignments(ownerId, "project", projectId, input);
  }

  async listProjectAssignments(
    ownerId: string,
    projectId: string,
  ): Promise<PolicyAssignmentList | null> {
    return this.listAssignments(ownerId, "project", projectId);
  }

  async replaceWorkspaceAssignments(
    ownerId: string,
    workspaceId: string,
    rawInput: PolicyAssignmentUpdate,
  ): Promise<number> {
    const input = policyAssignmentUpdateSchema.parse(rawInput);
    return this.replaceAssignments(ownerId, "workspace", workspaceId, input);
  }

  async listWorkspaceAssignments(
    ownerId: string,
    workspaceId: string,
  ): Promise<PolicyAssignmentList | null> {
    return this.listAssignments(ownerId, "workspace", workspaceId);
  }

  async resolveEffective(
    ownerId: string,
    projectId: string,
  ): Promise<EffectivePolicyList | null> {
    await this.ensureBootstrap(ownerId);
    const projects = await this.database
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.id, projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .limit(1);
    if (!projects[0]) return null;

    const [policyRows, directRows, workspaceRows] = await Promise.all([
      this.database
        .select()
        .from(schema.policies)
        .where(
          and(
            eq(schema.policies.ownerId, ownerId),
            eq(schema.policies.enabled, true),
          ),
        )
        .orderBy(asc(schema.policies.position), asc(schema.policies.key)),
      this.database
        .select({ policyId: schema.projectPolicyAssignments.policyId })
        .from(schema.projectPolicyAssignments)
        .where(eq(schema.projectPolicyAssignments.projectId, projectId)),
      this.database
        .select({
          policyId: schema.workspacePolicyAssignments.policyId,
          workspaceId: schema.projectWorkspaces.id,
        })
        .from(schema.workspacePolicyAssignments)
        .innerJoin(
          schema.projectWorkspaces,
          and(
            eq(
              schema.projectWorkspaces.id,
              schema.workspacePolicyAssignments.workspaceId,
            ),
            eq(schema.projectWorkspaces.ownerId, ownerId),
          ),
        )
        .innerJoin(
          schema.projectWorkspaceMemberships,
          and(
            eq(
              schema.projectWorkspaceMemberships.workspaceId,
              schema.projectWorkspaces.id,
            ),
            eq(schema.projectWorkspaceMemberships.projectId, projectId),
          ),
        )
        .orderBy(
          asc(schema.projectWorkspaces.position),
          asc(schema.projectWorkspaces.createdAt),
        ),
    ]);
    const directlyAssigned = new Set(
      directRows.map(({ policyId }) => policyId),
    );
    const workspacesByPolicy = new Map<
      string,
      Array<{ workspaceId: string }>
    >();
    for (const row of workspaceRows) {
      const current = workspacesByPolicy.get(row.policyId) ?? [];
      current.push({
        workspaceId: row.workspaceId,
      });
      workspacesByPolicy.set(row.policyId, current);
    }

    const effective = policyRows.flatMap((policy) => {
      const sources: EffectivePolicySource[] = [];
      if (policy.mandatory) sources.push({ type: "mandatory" });
      for (const workspace of workspacesByPolicy.get(policy.id) ?? []) {
        sources.push({ type: "workspace", ...workspace });
      }
      if (directlyAssigned.has(policy.id)) {
        sources.push({ type: "project", projectId });
      }
      return sources.length
        ? [
            {
              key: policy.key,
              name: policy.name,
              summary: policy.summary,
              mandatory: policy.mandatory,
              sources,
            },
          ]
        : [];
    });
    if (effective.length > EFFECTIVE_POLICY_LIMIT) {
      throw new PolicyConflictError(
        `Project ${projectId} has more than ${EFFECTIVE_POLICY_LIMIT} effective policies. Reduce or consolidate its effective policies before starting another Agent turn.`,
        "limit-exceeded",
      );
    }
    return effectivePolicyListSchema.parse({ policies: effective });
  }

  private async detail(row: PolicyRow): Promise<PolicyDetail> {
    const [workspaceCounts, projectCounts] = await Promise.all([
      this.database
        .select({ value: count() })
        .from(schema.workspacePolicyAssignments)
        .where(eq(schema.workspacePolicyAssignments.policyId, row.id)),
      this.database
        .select({ value: count() })
        .from(schema.projectPolicyAssignments)
        .where(eq(schema.projectPolicyAssignments.policyId, row.id)),
    ]);
    return toPolicyDetail(
      row,
      workspaceCounts[0]?.value ?? 0,
      projectCounts[0]?.value ?? 0,
    );
  }

  private async incrementCollectionVersion(
    transaction: PolicyTransaction,
    ownerId: string,
  ): Promise<number> {
    const rows = await transaction
      .update(schema.policyOwnerStates)
      .set({
        collectionVersion: sql`${schema.policyOwnerStates.collectionVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(schema.policyOwnerStates.ownerId, ownerId))
      .returning({
        collectionVersion: schema.policyOwnerStates.collectionVersion,
      });
    if (!rows[0]) throw new PolicyScopeNotFoundError("Policy owner not found.");
    return rows[0].collectionVersion;
  }

  private async claimCollectionVersion(
    transaction: PolicyTransaction,
    ownerId: string,
    collectionVersion: number,
  ): Promise<number> {
    const rows = await transaction
      .update(schema.policyOwnerStates)
      .set({ collectionVersion: collectionVersion + 1, updatedAt: new Date() })
      .where(
        and(
          eq(schema.policyOwnerStates.ownerId, ownerId),
          eq(schema.policyOwnerStates.collectionVersion, collectionVersion),
        ),
      )
      .returning({
        collectionVersion: schema.policyOwnerStates.collectionVersion,
      });
    if (!rows[0]) {
      throw new PolicyConflictError(
        "The policy collection changed in another session.",
        "collection-changed",
      );
    }
    return rows[0].collectionVersion;
  }

  private async replaceAssignments(
    ownerId: string,
    scope: "project" | "workspace",
    scopeId: string,
    input: PolicyAssignmentUpdate,
  ): Promise<number> {
    await this.ensureBootstrap(ownerId);
    return this.database.transaction(async (transaction) => {
      const collectionVersion = await this.claimCollectionVersion(
        transaction,
        ownerId,
        input.collectionVersion,
      );
      const scopeRows =
        scope === "project"
          ? await transaction
              .select({ id: schema.projects.id })
              .from(schema.projects)
              .where(
                and(
                  eq(schema.projects.id, scopeId),
                  eq(schema.projects.ownerId, ownerId),
                ),
              )
              .limit(1)
          : await transaction
              .select({ id: schema.projectWorkspaces.id })
              .from(schema.projectWorkspaces)
              .where(
                and(
                  eq(schema.projectWorkspaces.id, scopeId),
                  eq(schema.projectWorkspaces.ownerId, ownerId),
                ),
              )
              .limit(1);
      if (!scopeRows[0]) {
        throw new PolicyScopeNotFoundError(`Policy ${scope} not found.`);
      }
      const ownedPolicies = input.policyIds.length
        ? await transaction
            .select({ id: schema.policies.id })
            .from(schema.policies)
            .where(
              and(
                eq(schema.policies.ownerId, ownerId),
                inArray(schema.policies.id, input.policyIds),
              ),
            )
        : [];
      if (ownedPolicies.length !== input.policyIds.length) {
        throw new PolicyScopeNotFoundError(
          "Policy assignments contained an unavailable policy.",
        );
      }
      if (scope === "project") {
        await transaction
          .delete(schema.projectPolicyAssignments)
          .where(eq(schema.projectPolicyAssignments.projectId, scopeId));
        if (input.policyIds.length) {
          await transaction.insert(schema.projectPolicyAssignments).values(
            input.policyIds.map((policyId) => ({
              policyId,
              projectId: scopeId,
            })),
          );
        }
      } else {
        await transaction
          .delete(schema.workspacePolicyAssignments)
          .where(eq(schema.workspacePolicyAssignments.workspaceId, scopeId));
        if (input.policyIds.length) {
          await transaction.insert(schema.workspacePolicyAssignments).values(
            input.policyIds.map((policyId) => ({
              policyId,
              workspaceId: scopeId,
            })),
          );
        }
      }
      return collectionVersion;
    });
  }

  private async listAssignments(
    ownerId: string,
    scope: "project" | "workspace",
    scopeId: string,
  ): Promise<PolicyAssignmentList | null> {
    await this.ensureBootstrap(ownerId);
    const scopeRows =
      scope === "project"
        ? await this.database
            .select({ id: schema.projects.id })
            .from(schema.projects)
            .where(
              and(
                eq(schema.projects.id, scopeId),
                eq(schema.projects.ownerId, ownerId),
              ),
            )
            .limit(1)
        : await this.database
            .select({ id: schema.projectWorkspaces.id })
            .from(schema.projectWorkspaces)
            .where(
              and(
                eq(schema.projectWorkspaces.id, scopeId),
                eq(schema.projectWorkspaces.ownerId, ownerId),
              ),
            )
            .limit(1);
    if (!scopeRows[0]) return null;

    const [list, assignmentRows] = await Promise.all([
      this.list(ownerId),
      scope === "project"
        ? this.database
            .select({ policyId: schema.projectPolicyAssignments.policyId })
            .from(schema.projectPolicyAssignments)
            .innerJoin(
              schema.policies,
              and(
                eq(
                  schema.policies.id,
                  schema.projectPolicyAssignments.policyId,
                ),
                eq(schema.policies.ownerId, ownerId),
              ),
            )
            .where(eq(schema.projectPolicyAssignments.projectId, scopeId))
        : this.database
            .select({ policyId: schema.workspacePolicyAssignments.policyId })
            .from(schema.workspacePolicyAssignments)
            .innerJoin(
              schema.policies,
              and(
                eq(
                  schema.policies.id,
                  schema.workspacePolicyAssignments.policyId,
                ),
                eq(schema.policies.ownerId, ownerId),
              ),
            )
            .where(eq(schema.workspacePolicyAssignments.workspaceId, scopeId)),
    ]);
    const assigned = new Set(assignmentRows.map(({ policyId }) => policyId));
    return policyAssignmentListSchema.parse({
      collectionVersion: list.collectionVersion,
      policies: list.policies,
      directPolicyIds: list.policies.flatMap(({ id }) =>
        assigned.has(id) ? [id] : [],
      ),
    });
  }
}
