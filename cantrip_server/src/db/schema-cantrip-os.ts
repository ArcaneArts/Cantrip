import type {
  CantripOsDependencyOverlay,
  CantripOsTransport,
  ProjectSourceKind,
  ProjectSourceLocation,
} from "@cantrip/protocol";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { projects, projectWorktrees, users, workers } from "./schema.js";

/** Stable ownership shared by worker-local and Linux-owned source details. */
export const projectSourceIdentities = pgTable(
  "project_source_identities",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    workerId: text("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    locationKind: text("location_kind")
      .$type<ProjectSourceLocation["kind"]>()
      .notNull(),
  },
  (table) => [
    uniqueIndex("project_source_identities_id_kind_unique").on(
      table.id,
      table.locationKind,
    ),
    index("project_source_identities_project_worker_index").on(
      table.projectId,
      table.workerId,
    ),
    check(
      "project_source_identities_kind_check",
      sql`${table.locationKind} IN ('worker-local', 'cantrip-os')`,
    ),
  ],
);

export const cantripOsInstances = pgTable(
  "cantrip_os_instances",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workerId: text("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    guestInstanceId: text("guest_instance_id").notNull(),
    attachmentGeneration: text("attachment_generation").notNull(),
    transport: jsonb("transport").$type<CantripOsTransport>().notNull(),
    name: text("name").notNull(),
    status: text("status")
      .$type<"connected" | "disconnected" | "unknown">()
      .notNull()
      .default("unknown"),
    runtimeGeneration: text("runtime_generation"),
    lastError: text("last_error"),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("cantrip_os_instances_worker_guest_unique").on(
      table.workerId,
      table.guestInstanceId,
    ),
    check(
      "cantrip_os_instances_status_check",
      sql`${table.status} IN ('connected', 'disconnected', 'unknown')`,
    ),
    check(
      "cantrip_os_instances_connected_generation_check",
      sql`${table.status} <> 'connected' OR ${table.runtimeGeneration} IS NOT NULL`,
    ),
  ],
);

export const cantripOsWorkspaces = pgTable(
  "cantrip_os_workspaces",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id")
      .notNull()
      .references(() => cantripOsInstances.id, { onDelete: "cascade" }),
    guestWorkspaceId: text("guest_workspace_id").notNull(),
    uid: integer("uid").notNull(),
    gid: integer("gid").notNull(),
    homeGuestPath: text("home_guest_path").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("cantrip_os_workspaces_instance_guest_unique").on(
      table.instanceId,
      table.guestWorkspaceId,
    ),
    uniqueIndex("cantrip_os_workspaces_instance_uid_unique").on(
      table.instanceId,
      table.uid,
    ),
    check(
      "cantrip_os_workspaces_uid_check",
      sql`${table.uid} > 0 AND ${table.gid} > 0`,
    ),
    check(
      "cantrip_os_workspaces_home_check",
      sql`left(${table.homeGuestPath}, 1) = '/'`,
    ),
  ],
);

/** Guest paths never occupy project_sources.absolute_path, which remains local. */
export const cantripOsProjectSources = pgTable(
  "cantrip_os_project_sources",
  {
    id: text("id")
      .primaryKey()
      .references(() => projectSourceIdentities.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => cantripOsWorkspaces.id, { onDelete: "restrict" }),
    sourceKind: text("source_kind").$type<ProjectSourceKind>().notNull(),
    guestPath: text("guest_path").notNull(),
    ownershipKind: text("ownership_kind").$type<"cantrip" | "user">().notNull(),
    repositoryFingerprint: text("repository_fingerprint"),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("cantrip_os_project_sources_workspace_path_unique")
      .on(table.workspaceId, table.guestPath)
      .where(sql`${table.removedAt} IS NULL`),
    check(
      "cantrip_os_project_sources_kind_check",
      sql`${table.sourceKind} IN ('git', 'folder')`,
    ),
    check(
      "cantrip_os_project_sources_ownership_check",
      sql`${table.ownershipKind} IN ('cantrip', 'user')`,
    ),
    check(
      "cantrip_os_project_sources_guest_path_check",
      sql`left(${table.guestPath}, 1) = '/'`,
    ),
  ],
);

export const cantripOsSourceBindings = pgTable(
  "cantrip_os_source_bindings",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    workerId: text("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    projectSourceId: text("project_source_id")
      .notNull()
      .references(() => projectSourceIdentities.id, { onDelete: "cascade" }),
    worktreeId: text("worktree_id")
      .notNull()
      .references(() => projectWorktrees.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => cantripOsWorkspaces.id, { onDelete: "restrict" }),
    mode: text("mode").$type<"linked" | "linux-owned">().notNull(),
    linkedWorkerPath: text("linked_worker_path"),
    guestPath: text("guest_path").notNull(),
    bindingGeneration: text("binding_generation").notNull(),
    provisionedAttachmentGeneration: text("provisioned_attachment_generation"),
    provisionedRuntimeGeneration: text("provisioned_runtime_generation"),
    state: text("state")
      .$type<"provisioning" | "ready" | "failed" | "unknown" | "retired">()
      .notNull(),
    lastError: text("last_error"),
    dependencyOverlays: jsonb("dependency_overlays")
      .$type<CantripOsDependencyOverlay[]>()
      .notNull()
      .default([]),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("cantrip_os_bindings_worktree_workspace_unique")
      .on(table.worktreeId, table.workspaceId)
      .where(sql`${table.retiredAt} IS NULL`),
    check(
      "cantrip_os_bindings_mode_check",
      sql`(${table.mode} = 'linked' AND ${table.linkedWorkerPath} IS NOT NULL) OR (${table.mode} = 'linux-owned' AND ${table.linkedWorkerPath} IS NULL)`,
    ),
    check(
      "cantrip_os_bindings_state_check",
      sql`${table.state} IN ('provisioning', 'ready', 'failed', 'unknown', 'retired')`,
    ),
    check(
      "cantrip_os_bindings_retirement_check",
      sql`(${table.state} = 'retired') = (${table.retiredAt} IS NOT NULL)`,
    ),
    check(
      "cantrip_os_bindings_ready_generation_check",
      sql`${table.state} <> 'ready' OR (${table.provisionedAttachmentGeneration} IS NOT NULL AND ${table.provisionedRuntimeGeneration} IS NOT NULL)`,
    ),
    check(
      "cantrip_os_bindings_guest_path_check",
      sql`left(${table.guestPath}, 1) = '/'`,
    ),
    check(
      "cantrip_os_bindings_overlays_check",
      sql`jsonb_typeof(${table.dependencyOverlays}) = 'array' AND jsonb_array_length(${table.dependencyOverlays}) <= 32`,
    ),
  ],
);
