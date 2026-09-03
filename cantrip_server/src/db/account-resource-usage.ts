import type {
  AccountBandwidthChannel,
  AccountBandwidthDirection,
} from "@cantrip/protocol/resource-usage";
import {
  and,
  eq,
  getTableName,
  gt,
  gte,
  inArray,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
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
  ownerIds: string[];
  rowCount: bigint;
}

export interface AccountStorageHistoryMeasurement {
  bucketStart: Date;
  category: string;
  logicalBytes: bigint;
  rowCount: bigint;
  storageClass: AccountStorageClass;
}

export interface AccountBandwidthMeasurement {
  bucketStart: Date;
  bytes: bigint;
  channel: AccountBandwidthChannel;
  direction: AccountBandwidthDirection;
  operationCount: bigint;
  updatedAt: Date;
}

export interface AccountBandwidthFlushEntry {
  bucketStart: Date;
  bytes: bigint;
  channel: AccountBandwidthChannel;
  direction: AccountBandwidthDirection;
  operationCount: bigint;
  ownerId: string;
}

export interface AccountBandwidthFlushBatch {
  entries: AccountBandwidthFlushEntry[];
  flushedAt: Date;
  meterId: string;
  sequence: bigint;
}

export interface AccountBandwidthFlushResult {
  applied: boolean;
  ownerIds: string[];
}

export interface AccountUsageHistoryMaintenanceOptions {
  dailyRetentionDays: number;
  flushRetentionDays: number;
  hourlyRetentionDays: number;
  leaseMs?: number;
}

export interface AccountUsageHistoryMaintenanceResult {
  acquired: boolean;
  bandwidthDailyRowsDeleted: number;
  bandwidthDaysRolled: number;
  bandwidthHourlyRowsDeleted: number;
  flushRowsDeleted: number;
  storageDailyRowsDeleted: number;
  storageDaysRolled: number;
  storageHourlyRowsDeleted: number;
}

export interface AccountUsageOperationalTotals {
  accountCount: number;
  logicalServerBytes: bigint;
  logicalWorkerManagedBytes: bigint;
  physicalDatabaseBytes: bigint | null;
}

interface RawMeasurementRow extends Record<string, unknown> {
  category: AccountStorageMeasurement["category"];
  logical_bytes: bigint | number | string;
  owner_id: string;
  row_count: bigint | number | string;
  storage_class: AccountStorageClass;
}

interface RawHistoryRow extends Record<string, unknown> {
  bucket_start: Date | string;
  category: string;
  logical_bytes: bigint | number | string;
  row_count: bigint | number | string;
  storage_class: AccountStorageClass;
}

interface RawBandwidthRow extends Record<string, unknown> {
  bucket_start: Date | string;
  bytes: bigint | number | string;
  channel: AccountBandwidthChannel;
  direction: AccountBandwidthDirection;
  operation_count: bigint | number | string;
  updated_at: Date | string;
}

interface RawCountRow extends Record<string, unknown> {
  row_count: bigint | number | string;
}

interface RawOperationalTotalsRow extends Record<string, unknown> {
  account_count: bigint | number | string;
  logical_server_bytes: bigint | number | string;
  logical_worker_managed_bytes: bigint | number | string;
}

interface RawPhysicalDatabaseSizeRow extends Record<string, unknown> {
  physical_database_bytes: bigint | number | string;
}

interface OwnerSql {
  expression: string;
  joins: string;
}

const STORAGE_RECONCILIATION_LEASE_KEY = "full-storage-reconciliation";
const USAGE_HISTORY_MAINTENANCE_LEASE_KEY = "usage-history-maintenance";
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
    case "tunnel-attachment":
      return {
        expression: 'tunnel."owner_id"',
        joins:
          'inner join "tunnel_attachments" attachment on attachment."id" = t."attachment_id" inner join "tunnels" tunnel on tunnel."id" = attachment."tunnel_id"',
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

function timestampParameter(value: Date) {
  return sql.param(value, schema.accountStorageUsageSnapshots.bucketStart);
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

function dayBucket(value: Date): Date {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
  );
}

function countRows(result: unknown): number {
  const row = resultRows<RawCountRow>(result)[0];
  return row ? Number(bigintValue(row.row_count)) : 0;
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

  listCurrentStorage(ownerId: string) {
    return this.database
      .select()
      .from(schema.accountStorageUsageCurrent)
      .where(eq(schema.accountStorageUsageCurrent.ownerId, ownerId))
      .orderBy(
        schema.accountStorageUsageCurrent.storageClass,
        schema.accountStorageUsageCurrent.category,
      );
  }

  async listStorageHistory(
    ownerId: string,
    from: Date,
    to: Date,
    resolution: "day" | "hour",
  ): Promise<AccountStorageHistoryMeasurement[]> {
    if (resolution === "hour") {
      const rows = await this.database
        .select({
          bucketStart: schema.accountStorageUsageSnapshots.bucketStart,
          category: schema.accountStorageUsageSnapshots.category,
          logicalBytes: schema.accountStorageUsageSnapshots.logicalBytes,
          rowCount: schema.accountStorageUsageSnapshots.rowCount,
          storageClass: schema.accountStorageUsageSnapshots.storageClass,
        })
        .from(schema.accountStorageUsageSnapshots)
        .where(
          and(
            eq(schema.accountStorageUsageSnapshots.ownerId, ownerId),
            eq(schema.accountStorageUsageSnapshots.resolution, "hour"),
            gte(schema.accountStorageUsageSnapshots.bucketStart, from),
            lt(schema.accountStorageUsageSnapshots.bucketStart, to),
          ),
        )
        .orderBy(
          schema.accountStorageUsageSnapshots.bucketStart,
          schema.accountStorageUsageSnapshots.storageClass,
          schema.accountStorageUsageSnapshots.category,
        );
      return rows.map((row) => ({
        ...row,
        storageClass: row.storageClass as AccountStorageClass,
      }));
    }

    const result = await this.database.execute<RawHistoryRow>(sql`
      select bucket_start, storage_class, category,
        logical_bytes::text as logical_bytes,
        row_count::text as row_count
      from (
        select date_trunc('day', bucket_start at time zone 'UTC') at time zone 'UTC' as bucket_start,
          storage_class,
          category,
          logical_bytes,
          row_count,
          row_number() over (
            partition by date_trunc('day', bucket_start at time zone 'UTC'), storage_class, category
            order by measured_at desc, bucket_start desc
          ) as recency
        from ${schema.accountStorageUsageSnapshots}
        where owner_id = ${ownerId}
          and resolution in ('hour', 'day')
          and bucket_start >= ${timestampParameter(from)}
          and bucket_start < ${timestampParameter(to)}
      ) daily
      where recency = 1
      order by bucket_start, storage_class, category
    `);
    return resultRows<RawHistoryRow>(result).map((row) => ({
      bucketStart:
        row.bucket_start instanceof Date
          ? row.bucket_start
          : new Date(row.bucket_start),
      category: row.category,
      logicalBytes: bigintValue(row.logical_bytes),
      rowCount: bigintValue(row.row_count),
      storageClass: row.storage_class,
    }));
  }

  async flushBandwidthBatch(
    batch: AccountBandwidthFlushBatch,
  ): Promise<AccountBandwidthFlushResult> {
    if (batch.entries.length === 0) {
      return { applied: false, ownerIds: [] };
    }
    return this.database.transaction(async (transaction) => {
      const requestedOwnerIds = [
        ...new Set(batch.entries.map((entry) => entry.ownerId)),
      ];
      const owners = await transaction
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(inArray(schema.users.id, requestedOwnerIds));
      const activeOwnerIds = new Set(owners.map((owner) => owner.id));
      const inserted = await transaction
        .insert(schema.accountBandwidthFlushes)
        .values({
          meterId: batch.meterId,
          sequence: batch.sequence,
          entryCount: batch.entries.length,
          bytes: batch.entries.reduce(
            (total, entry) => total + entry.bytes,
            0n,
          ),
          flushedAt: batch.flushedAt,
        })
        .onConflictDoNothing()
        .returning({ meterId: schema.accountBandwidthFlushes.meterId });
      if (inserted.length === 0) {
        return { applied: false, ownerIds: [...activeOwnerIds].sort() };
      }
      const entries = batch.entries.filter((entry) =>
        activeOwnerIds.has(entry.ownerId),
      );
      if (entries.length > 0) {
        await transaction
          .insert(schema.accountBandwidthUsageBuckets)
          .values(
            entries.map((entry) => ({
              ownerId: entry.ownerId,
              bucketStart: entry.bucketStart,
              resolution: "hour",
              channel: entry.channel,
              direction: entry.direction,
              bytes: entry.bytes,
              operationCount: entry.operationCount,
              updatedAt: batch.flushedAt,
            })),
          )
          .onConflictDoUpdate({
            target: [
              schema.accountBandwidthUsageBuckets.ownerId,
              schema.accountBandwidthUsageBuckets.bucketStart,
              schema.accountBandwidthUsageBuckets.resolution,
              schema.accountBandwidthUsageBuckets.channel,
              schema.accountBandwidthUsageBuckets.direction,
            ],
            set: {
              bytes: sql`${schema.accountBandwidthUsageBuckets.bytes} + excluded.bytes`,
              operationCount: sql`${schema.accountBandwidthUsageBuckets.operationCount} + excluded.operation_count`,
              updatedAt: batch.flushedAt,
            },
          });
      }
      return {
        applied: true,
        ownerIds: [...activeOwnerIds].sort(),
      };
    });
  }

  async listBandwidthHistory(
    ownerId: string,
    from: Date,
    to: Date,
    resolution: "day" | "hour",
  ): Promise<AccountBandwidthMeasurement[]> {
    const bucketExpression =
      resolution === "hour"
        ? sql`bucket_start`
        : sql`date_trunc('day', bucket_start at time zone 'UTC') at time zone 'UTC'`;
    const resolutionFilter =
      resolution === "hour"
        ? sql`resolution = 'hour'`
        : sql`resolution in ('hour', 'day')`;
    const result = await this.database.execute<RawBandwidthRow>(sql`
      select ${bucketExpression} as bucket_start,
        channel,
        direction,
        sum(bytes)::text as bytes,
        sum(operation_count)::text as operation_count,
        max(updated_at) as updated_at
      from ${schema.accountBandwidthUsageBuckets}
      where owner_id = ${ownerId}
        and ${resolutionFilter}
        and bucket_start >= ${timestampParameter(from)}
        and bucket_start < ${timestampParameter(to)}
      group by ${bucketExpression}, channel, direction
      order by bucket_start, channel, direction
    `);
    return resultRows<RawBandwidthRow>(result).map((row) => ({
      bucketStart:
        row.bucket_start instanceof Date
          ? row.bucket_start
          : new Date(row.bucket_start),
      bytes: bigintValue(row.bytes),
      channel: row.channel,
      direction: row.direction,
      operationCount: bigintValue(row.operation_count),
      updatedAt:
        row.updated_at instanceof Date
          ? row.updated_at
          : new Date(row.updated_at),
    }));
  }

  async getOperationalTotals(): Promise<AccountUsageOperationalTotals> {
    const totalsResult = await this.database.execute<RawOperationalTotalsRow>(
      sql`
        select count(distinct owner_id)::text as account_count,
          coalesce(sum(logical_bytes) filter (where storage_class = 'server'), 0)::text as logical_server_bytes,
          coalesce(sum(logical_bytes) filter (where storage_class = 'worker-managed'), 0)::text as logical_worker_managed_bytes
        from ${schema.accountStorageUsageCurrent}
      `,
    );
    const totals = resultRows<RawOperationalTotalsRow>(totalsResult)[0];
    let physicalDatabaseBytes: bigint | null = null;
    try {
      const physicalResult =
        await this.database.execute<RawPhysicalDatabaseSizeRow>(
          sql`select pg_database_size(current_database())::text as physical_database_bytes`,
        );
      const physical =
        resultRows<RawPhysicalDatabaseSizeRow>(physicalResult)[0];
      if (physical) {
        physicalDatabaseBytes = bigintValue(physical.physical_database_bytes);
      }
    } catch {
      // Some embedded/test PostgreSQL-compatible engines do not expose this.
    }
    return {
      accountCount: totals ? Number(bigintValue(totals.account_count)) : 0,
      logicalServerBytes: totals
        ? bigintValue(totals.logical_server_bytes)
        : 0n,
      logicalWorkerManagedBytes: totals
        ? bigintValue(totals.logical_worker_managed_bytes)
        : 0n,
      physicalDatabaseBytes,
    };
  }

  async maintainUsageHistory(
    holderId: string,
    now: Date,
    options: AccountUsageHistoryMaintenanceOptions,
  ): Promise<AccountUsageHistoryMaintenanceResult> {
    if (
      !Number.isFinite(now.getTime()) ||
      !Number.isSafeInteger(options.hourlyRetentionDays) ||
      options.hourlyRetentionDays < 1 ||
      !Number.isSafeInteger(options.dailyRetentionDays) ||
      options.dailyRetentionDays <= options.hourlyRetentionDays ||
      !Number.isSafeInteger(options.flushRetentionDays) ||
      options.flushRetentionDays < 1
    ) {
      throw new Error("Account usage history maintenance options are invalid.");
    }
    const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    const acquired = await this.acquireUsageLease(
      USAGE_HISTORY_MAINTENANCE_LEASE_KEY,
      holderId,
      now,
      leaseMs,
    );
    const emptyResult: AccountUsageHistoryMaintenanceResult = {
      acquired,
      bandwidthDailyRowsDeleted: 0,
      bandwidthDaysRolled: 0,
      bandwidthHourlyRowsDeleted: 0,
      flushRowsDeleted: 0,
      storageDailyRowsDeleted: 0,
      storageDaysRolled: 0,
      storageHourlyRowsDeleted: 0,
    };
    if (!acquired) return emptyResult;

    const hourlyCutoff = dayBucket(
      new Date(now.getTime() - options.hourlyRetentionDays * 86_400_000),
    );
    const dailyCutoff = dayBucket(
      new Date(now.getTime() - options.dailyRetentionDays * 86_400_000),
    );
    const flushCutoff = new Date(
      now.getTime() - options.flushRetentionDays * 86_400_000,
    );

    try {
      return await this.database.transaction(async (transaction) => {
        const refreshedAt = now;
        const leaseRows = await transaction
          .update(schema.accountStorageReconciliationLeases)
          .set({
            expiresAt: new Date(refreshedAt.getTime() + leaseMs),
            updatedAt: refreshedAt,
          })
          .where(
            and(
              eq(
                schema.accountStorageReconciliationLeases.key,
                USAGE_HISTORY_MAINTENANCE_LEASE_KEY,
              ),
              eq(schema.accountStorageReconciliationLeases.holderId, holderId),
              gt(
                schema.accountStorageReconciliationLeases.expiresAt,
                refreshedAt,
              ),
            ),
          )
          .returning({ key: schema.accountStorageReconciliationLeases.key });
        if (leaseRows.length !== 1) {
          throw new StorageReconciliationLeaseLostError();
        }

        const bandwidthRollup = await transaction.execute<RawCountRow>(sql`
          with daily as (
            select owner_id,
              date_trunc('day', bucket_start at time zone 'UTC') at time zone 'UTC' as bucket_start,
              channel,
              direction,
              sum(bytes)::bigint as bytes,
              sum(operation_count)::bigint as operation_count,
              max(updated_at) as updated_at
            from ${schema.accountBandwidthUsageBuckets}
            where resolution = 'hour'
              and bucket_start >= ${timestampParameter(dailyCutoff)}
              and bucket_start < ${timestampParameter(hourlyCutoff)}
            group by owner_id,
              date_trunc('day', bucket_start at time zone 'UTC'),
              channel,
              direction
          ), upserted as (
            insert into ${schema.accountBandwidthUsageBuckets}
              (owner_id, bucket_start, resolution, channel, direction, bytes, operation_count, created_at, updated_at)
            select owner_id, bucket_start, 'day', channel, direction, bytes, operation_count, ${timestampParameter(now)}, updated_at
            from daily
            on conflict (owner_id, bucket_start, resolution, channel, direction)
            do update set bytes = ${schema.accountBandwidthUsageBuckets}.bytes + excluded.bytes,
              operation_count = ${schema.accountBandwidthUsageBuckets}.operation_count + excluded.operation_count,
              updated_at = excluded.updated_at
            returning 1
          ) select count(*)::text as row_count from upserted
        `);

        const storageRollup = await transaction.execute<RawCountRow>(sql`
          with ranked as (
            select owner_id,
              date_trunc('day', bucket_start at time zone 'UTC') at time zone 'UTC' as bucket_start,
              storage_class,
              category,
              logical_bytes,
              row_count,
              basis_version,
              measured_at,
              updated_at,
              row_number() over (
                partition by owner_id,
                  date_trunc('day', bucket_start at time zone 'UTC'),
                  storage_class,
                  category
                order by bucket_start desc, measured_at desc
              ) as recency
            from ${schema.accountStorageUsageSnapshots}
            where resolution = 'hour'
              and bucket_start >= ${timestampParameter(dailyCutoff)}
              and bucket_start < ${timestampParameter(hourlyCutoff)}
          ), upserted as (
            insert into ${schema.accountStorageUsageSnapshots}
              (owner_id, bucket_start, resolution, storage_class, category, logical_bytes, row_count, basis_version, measured_at, created_at, updated_at)
            select owner_id, bucket_start, 'day', storage_class, category, logical_bytes, row_count, basis_version, measured_at, ${timestampParameter(now)}, updated_at
            from ranked where recency = 1
            on conflict (owner_id, bucket_start, resolution, storage_class, category)
            do update set
              logical_bytes = case when excluded.measured_at > ${schema.accountStorageUsageSnapshots}.measured_at then excluded.logical_bytes else ${schema.accountStorageUsageSnapshots}.logical_bytes end,
              row_count = case when excluded.measured_at > ${schema.accountStorageUsageSnapshots}.measured_at then excluded.row_count else ${schema.accountStorageUsageSnapshots}.row_count end,
              basis_version = case when excluded.measured_at > ${schema.accountStorageUsageSnapshots}.measured_at then excluded.basis_version else ${schema.accountStorageUsageSnapshots}.basis_version end,
              measured_at = greatest(${schema.accountStorageUsageSnapshots}.measured_at, excluded.measured_at),
              updated_at = greatest(${schema.accountStorageUsageSnapshots}.updated_at, excluded.updated_at)
            returning 1
          ) select count(*)::text as row_count from upserted
        `);

        const bandwidthHours = await transaction
          .delete(schema.accountBandwidthUsageBuckets)
          .where(
            and(
              eq(schema.accountBandwidthUsageBuckets.resolution, "hour"),
              lt(schema.accountBandwidthUsageBuckets.bucketStart, hourlyCutoff),
            ),
          )
          .returning({ ownerId: schema.accountBandwidthUsageBuckets.ownerId });
        const storageHours = await transaction
          .delete(schema.accountStorageUsageSnapshots)
          .where(
            and(
              eq(schema.accountStorageUsageSnapshots.resolution, "hour"),
              lt(schema.accountStorageUsageSnapshots.bucketStart, hourlyCutoff),
            ),
          )
          .returning({ ownerId: schema.accountStorageUsageSnapshots.ownerId });
        const bandwidthDays = await transaction
          .delete(schema.accountBandwidthUsageBuckets)
          .where(
            and(
              eq(schema.accountBandwidthUsageBuckets.resolution, "day"),
              lt(schema.accountBandwidthUsageBuckets.bucketStart, dailyCutoff),
            ),
          )
          .returning({ ownerId: schema.accountBandwidthUsageBuckets.ownerId });
        const storageDays = await transaction
          .delete(schema.accountStorageUsageSnapshots)
          .where(
            and(
              eq(schema.accountStorageUsageSnapshots.resolution, "day"),
              lt(schema.accountStorageUsageSnapshots.bucketStart, dailyCutoff),
            ),
          )
          .returning({ ownerId: schema.accountStorageUsageSnapshots.ownerId });
        const flushes = await transaction
          .delete(schema.accountBandwidthFlushes)
          .where(lt(schema.accountBandwidthFlushes.flushedAt, flushCutoff))
          .returning({ meterId: schema.accountBandwidthFlushes.meterId });

        return {
          acquired: true,
          bandwidthDailyRowsDeleted: bandwidthDays.length,
          bandwidthDaysRolled: countRows(bandwidthRollup),
          bandwidthHourlyRowsDeleted: bandwidthHours.length,
          flushRowsDeleted: flushes.length,
          storageDailyRowsDeleted: storageDays.length,
          storageDaysRolled: countRows(storageRollup),
          storageHourlyRowsDeleted: storageHours.length,
        };
      });
    } finally {
      await this.releaseUsageLease(
        USAGE_HISTORY_MAINTENANCE_LEASE_KEY,
        holderId,
      );
    }
  }

  async acquireUsageLease(
    key: string,
    holderId: string,
    now: Date,
    leaseMs = DEFAULT_LEASE_MS,
  ): Promise<boolean> {
    if (!key.trim() || !holderId.trim() || leaseMs < 1) return false;
    const expiresAt = new Date(now.getTime() + leaseMs);
    const rows = await this.database
      .insert(schema.accountStorageReconciliationLeases)
      .values({ key, holderId, expiresAt, updatedAt: now })
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

  async releaseUsageLease(key: string, holderId: string): Promise<void> {
    await this.database
      .delete(schema.accountStorageReconciliationLeases)
      .where(
        and(
          eq(schema.accountStorageReconciliationLeases.key, key),
          eq(schema.accountStorageReconciliationLeases.holderId, holderId),
        ),
      );
  }

  async acquireStorageReconciliationLease(
    holderId: string,
    now: Date,
    leaseMs = DEFAULT_LEASE_MS,
  ): Promise<boolean> {
    return this.acquireUsageLease(
      STORAGE_RECONCILIATION_LEASE_KEY,
      holderId,
      now,
      leaseMs,
    );
  }

  async releaseStorageReconciliationLease(holderId: string): Promise<void> {
    await this.releaseUsageLease(STORAGE_RECONCILIATION_LEASE_KEY, holderId);
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
        ownerIds: [],
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
              resolution: "hour",
              measuredAt,
              createdAt: reconciledAt,
              updatedAt: reconciledAt,
            })),
          )
          .onConflictDoUpdate({
            target: [
              schema.accountStorageUsageSnapshots.ownerId,
              schema.accountStorageUsageSnapshots.bucketStart,
              schema.accountStorageUsageSnapshots.resolution,
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
        ownerIds: [
          ...new Set(measurements.map((measurement) => measurement.ownerId)),
        ].sort(),
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
