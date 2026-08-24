import { and, eq, getTableName, gt, lte, or, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";

import {
  STORAGE_ACCOUNTING_BASIS_VERSION,
  STORAGE_ACCOUNTING_MANIFEST,
  type StorageAccountingCategory,
  type StorageOwnerResolution,
} from "../account-usage/storage-manifest.js";
import * as schema from "./schema.js";

type ResourceUsageDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

export type AccountStorageClass = "server" | "worker-managed";

export interface AccountStorageMeasurement {
  category: StorageAccountingCategory | "attachment-replicas" | "attachments";
  logicalBytes: bigint;
  ownerId: string;
  rowCount: bigint;
  storageClass: AccountStorageClass;
}

export interface AccountStorageReconciliationResult {
  acquired: boolean;
  accountCount: number;
  categoryCount: number;
  logicalBytes: bigint;
  measuredAt: Date;
  rowCount: bigint;
}

interface RawMeasurementRow extends Record<string, unknown> {
  category: AccountStorageMeasurement["category"];
  logical_bytes: bigint | number | string;
  owner_id: string;
  row_count: bigint | number | string;
  storage_class: AccountStorageClass;
}

interface OwnerSql {
  expression: string;
  joins: string;
}

const STORAGE_RECONCILIATION_LEASE_KEY = "full-storage-reconciliation";
const DEFAULT_LEASE_MS = 30 * 60_000;

export class StorageReconciliationLeaseLostError extends Error {
  constructor() {
    super("Storage reconciliation lease expired before projection update.");
    this.name = "StorageReconciliationLeaseLostError";
  }
}

function quotedIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(value)) {
    throw new Error(`Unsafe accounting identifier: ${value}`);
  }
  return `"${value}"`;
}

function ownerSql(resolution: StorageOwnerResolution): OwnerSql {
  switch (resolution) {
    case "self":
      return { expression: 't."id"', joins: "" };
    case "owner-column":
      return { expression: 't."owner_id"', joins: "" };
    case "user":
      return { expression: 't."user_id"', joins: "" };
    case "provider":
      return {
        expression: 'provider."owner_id"',
        joins:
          'inner join "model_providers" provider on provider."id" = t."provider_id"',
      };
    case "provider-account":
      return {
        expression: 'provider."owner_id"',
        joins:
          'inner join "model_provider_accounts" account on account."id" = t."account_id" inner join "model_providers" provider on provider."id" = account."provider_id"',
      };
    case "provider-model":
      return {
        expression: 'provider."owner_id"',
        joins:
          'inner join "provider_models" provider_model on provider_model."id" = t."provider_model_id" inner join "model_providers" provider on provider."id" = provider_model."provider_id"',
      };
    case "model-profile":
      return {
        expression: 'model."owner_id"',
        joins: 'inner join "model_profiles" model on model."id" = t."model_id"',
      };
    case "project":
      return {
        expression: 'project."owner_id"',
        joins: 'inner join "projects" project on project."id" = t."project_id"',
      };
    case "project-source":
      return {
        expression: 'project."owner_id"',
        joins:
          'inner join "project_sources" source on source."id" = t."project_source_id" inner join "projects" project on project."id" = source."project_id"',
      };
    case "workspace":
      return {
        expression: 'workspace."owner_id"',
        joins:
          'inner join "project_workspaces" workspace on workspace."id" = t."workspace_id"',
      };
    case "tunnel":
      return {
        expression: 'tunnel."owner_id"',
        joins: 'inner join "tunnels" tunnel on tunnel."id" = t."tunnel_id"',
      };
    case "chat":
      return {
        expression: 'project."owner_id"',
        joins:
          'inner join "chats" chat on chat."id" = t."chat_id" inner join "projects" project on project."id" = chat."project_id"',
      };
    case "attachment":
      return {
        expression: 'project."owner_id"',
        joins:
          'inner join "chat_attachments" attachment on attachment."id" = t."attachment_id" inner join "chats" chat on chat."id" = attachment."chat_id" inner join "projects" project on project."id" = chat."project_id"',
      };
    case "workflow-definition":
      return {
        expression: 'workflow."owner_id"',
        joins:
          'inner join "workflow_definitions" workflow on workflow."id" = t."workflow_id"',
      };
    case "workflow-revision":
      return {
        expression: 'workflow."owner_id"',
        joins:
          'inner join "workflow_revisions" revision on revision."id" = t."revision_id" inner join "workflow_definitions" workflow on workflow."id" = revision."workflow_id"',
      };
    case "workflow-trigger":
      return {
        expression: 'trigger."owner_id"',
        joins:
          'inner join "workflow_automation_triggers" trigger on trigger."id" = t."trigger_id"',
      };
    case "workflow-run":
      return {
        expression: 'run."owner_id"',
        joins: 'inner join "workflow_runs" run on run."id" = t."run_id"',
      };
    case "workflow-run-node":
      return {
        expression: 'run."owner_id"',
        joins:
          'inner join "workflow_run_nodes" run_node on run_node."id" = t."run_node_id" inner join "workflow_runs" run on run."id" = run_node."run_id"',
      };
  }
}

function serverMeasurementSql(): string[] {
  return STORAGE_ACCOUNTING_MANIFEST.flatMap((entry) => {
    if (!entry.category || !entry.ownerResolution) return [];
    const tableName = quotedIdentifier(getTableName(entry.table));
    const owner = ownerSql(entry.ownerResolution);
    return [
      `select ${owner.expression} as owner_id, 'server'::text as storage_class, '${entry.category}'::text as category, sum(pg_column_size(t.*))::bigint as logical_bytes, count(*)::bigint as row_count from ${tableName} t ${owner.joins} where ${owner.expression} is not null group by ${owner.expression}`,
    ];
  });
}

function workerManagedMeasurementSql(): string[] {
  return [
    `select project."owner_id" as owner_id, 'worker-managed'::text as storage_class, 'attachments'::text as category, coalesce(sum(attachment."size_bytes"), 0)::bigint as logical_bytes, count(*)::bigint as row_count from "chat_attachments" attachment inner join "chats" chat on chat."id" = attachment."chat_id" inner join "projects" project on project."id" = chat."project_id" where attachment."status" = 'ready' group by project."owner_id"`,
    `select project."owner_id" as owner_id, 'worker-managed'::text as storage_class, 'attachment-replicas'::text as category, coalesce(sum(attachment."size_bytes"), 0)::bigint as logical_bytes, count(*)::bigint as row_count from "chat_attachment_replicas" replica inner join "chat_attachments" attachment on attachment."id" = replica."attachment_id" inner join "chats" chat on chat."id" = attachment."chat_id" inner join "projects" project on project."id" = chat."project_id" where replica."status" = 'ready' group by project."owner_id"`,
  ];
}

export function accountStorageMeasurementQuery(): string {
  const measurements = [
    ...serverMeasurementSql(),
    ...workerManagedMeasurementSql(),
  ];
  return `select owner_id, storage_class, category, sum(logical_bytes)::text as logical_bytes, sum(row_count)::text as row_count from (${measurements.join(
    " union all ",
  )}) measurements group by owner_id, storage_class, category order by owner_id, storage_class, category`;
}

function bigintValue(value: bigint | number | string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new Error(
      "Storage measurement exceeded JavaScript's safe integer range.",
    );
  }
  return BigInt(value);
}

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (
    result &&
    typeof result === "object" &&
    "rows" in result &&
    Array.isArray(result.rows)
  ) {
    return result.rows as T[];
  }
  throw new Error("Database returned an unsupported accounting result shape.");
}

function hourBucket(value: Date): Date {
  return new Date(
    Date.UTC(
      value.getUTCFullYear(),
      value.getUTCMonth(),
      value.getUTCDate(),
      value.getUTCHours(),
    ),
  );
}

export class AccountResourceUsageRepository {
  constructor(private readonly database: ResourceUsageDatabase) {}

  async measureStorage(): Promise<AccountStorageMeasurement[]> {
    const result = await this.database.execute<RawMeasurementRow>(
      sql.raw(accountStorageMeasurementQuery()),
    );
    return resultRows<RawMeasurementRow>(result).map((row) => ({
      category: row.category,
      logicalBytes: bigintValue(row.logical_bytes),
      ownerId: row.owner_id,
      rowCount: bigintValue(row.row_count),
      storageClass: row.storage_class,
    }));
  }

  async acquireStorageReconciliationLease(
    holderId: string,
    now: Date,
    leaseMs = DEFAULT_LEASE_MS,
  ): Promise<boolean> {
    const expiresAt = new Date(now.getTime() + leaseMs);
    const rows = await this.database
      .insert(schema.accountStorageReconciliationLeases)
      .values({
        key: STORAGE_RECONCILIATION_LEASE_KEY,
        holderId,
        expiresAt,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.accountStorageReconciliationLeases.key,
        set: { holderId, expiresAt, updatedAt: now },
        setWhere: or(
          lte(schema.accountStorageReconciliationLeases.expiresAt, now),
          eq(schema.accountStorageReconciliationLeases.holderId, holderId),
        ),
      })
      .returning({ key: schema.accountStorageReconciliationLeases.key });
    return rows.length === 1;
  }

  async releaseStorageReconciliationLease(holderId: string): Promise<void> {
    await this.database
      .delete(schema.accountStorageReconciliationLeases)
      .where(
        and(
          eq(
            schema.accountStorageReconciliationLeases.key,
            STORAGE_RECONCILIATION_LEASE_KEY,
          ),
          eq(schema.accountStorageReconciliationLeases.holderId, holderId),
        ),
      );
  }

  async reconcileStorage(
    holderId: string,
    measuredAt = new Date(),
  ): Promise<AccountStorageReconciliationResult> {
    const leaseAcquiredAt = new Date();
    const acquired = await this.acquireStorageReconciliationLease(
      holderId,
      leaseAcquiredAt,
    );
    if (!acquired) {
      return {
        acquired: false,
        accountCount: 0,
        categoryCount: 0,
        logicalBytes: 0n,
        measuredAt,
        rowCount: 0n,
      };
    }

    try {
      const measurements = await this.measureStorage();
      const reconciledAt = new Date();
      const bucketStart = hourBucket(measuredAt);
      await this.database.transaction(async (transaction) => {
        const leaseRows = await transaction
          .update(schema.accountStorageReconciliationLeases)
          .set({
            expiresAt: new Date(reconciledAt.getTime() + DEFAULT_LEASE_MS),
            updatedAt: reconciledAt,
          })
          .where(
            and(
              eq(
                schema.accountStorageReconciliationLeases.key,
                STORAGE_RECONCILIATION_LEASE_KEY,
              ),
              eq(schema.accountStorageReconciliationLeases.holderId, holderId),
              gt(
                schema.accountStorageReconciliationLeases.expiresAt,
                reconciledAt,
              ),
            ),
          )
          .returning({ key: schema.accountStorageReconciliationLeases.key });
        if (leaseRows.length !== 1) {
          throw new StorageReconciliationLeaseLostError();
        }
        await transaction.delete(schema.accountStorageUsageCurrent);
        if (measurements.length === 0) return;
        await transaction.insert(schema.accountStorageUsageCurrent).values(
          measurements.map((measurement) => ({
            ...measurement,
            basisVersion: STORAGE_ACCOUNTING_BASIS_VERSION,
            measuredAt,
            reconciledAt,
          })),
        );
        await transaction
          .insert(schema.accountStorageUsageSnapshots)
          .values(
            measurements.map((measurement) => ({
              ...measurement,
              basisVersion: STORAGE_ACCOUNTING_BASIS_VERSION,
              bucketStart,
              measuredAt,
              createdAt: reconciledAt,
              updatedAt: reconciledAt,
            })),
          )
          .onConflictDoUpdate({
            target: [
              schema.accountStorageUsageSnapshots.ownerId,
              schema.accountStorageUsageSnapshots.bucketStart,
              schema.accountStorageUsageSnapshots.storageClass,
              schema.accountStorageUsageSnapshots.category,
            ],
            set: {
              logicalBytes: sql`excluded.logical_bytes`,
              rowCount: sql`excluded.row_count`,
              basisVersion: sql`excluded.basis_version`,
              measuredAt: sql`excluded.measured_at`,
              updatedAt: reconciledAt,
            },
          });
      });

      return {
        acquired: true,
        accountCount: new Set(
          measurements.map((measurement) => measurement.ownerId),
        ).size,
        categoryCount: measurements.length,
        logicalBytes: measurements.reduce(
          (total, measurement) => total + measurement.logicalBytes,
          0n,
        ),
        measuredAt,
        rowCount: measurements.reduce(
          (total, measurement) => total + measurement.rowCount,
          0n,
        ),
      };
    } finally {
      await this.releaseStorageReconciliationLease(holderId);
    }
  }
}
