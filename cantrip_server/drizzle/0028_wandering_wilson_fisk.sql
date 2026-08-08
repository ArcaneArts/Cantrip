CREATE TABLE "workflow_approval_gates" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"run_node_id" text,
	"gate_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"prompt" text NOT NULL,
	"permission_manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"interaction_request_id" text,
	"requested_by_type" text NOT NULL,
	"requested_by_id" text,
	"decision" text,
	"decided_by_user_id" text,
	"decision_reason" text,
	"expires_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_approval_gates_status_check" CHECK ("workflow_approval_gates"."status" IN ('pending', 'approved', 'denied', 'expired', 'cancelled')),
	CONSTRAINT "workflow_approval_gates_decision_check" CHECK ("workflow_approval_gates"."decision" IS NULL OR "workflow_approval_gates"."decision" IN ('approved', 'denied'))
);
--> statement-breakpoint
CREATE TABLE "workflow_definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"project_id" text,
	"scope" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"source" text DEFAULT 'cantrip' NOT NULL,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"trust_state" text DEFAULT 'untrusted' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_definitions_scope_check" CHECK ("workflow_definitions"."scope" IN ('personal', 'project')),
	CONSTRAINT "workflow_definitions_scope_project_check" CHECK (("workflow_definitions"."scope" = 'personal' AND "workflow_definitions"."project_id" IS NULL) OR ("workflow_definitions"."scope" = 'project' AND "workflow_definitions"."project_id" IS NOT NULL)),
	CONSTRAINT "workflow_definitions_trust_state_check" CHECK ("workflow_definitions"."trust_state" IN ('untrusted', 'trusted', 'modified', 'blocked'))
);
--> statement-breakpoint
CREATE TABLE "workflow_node_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"run_node_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"idempotency_key" text NOT NULL,
	"structured_input" jsonb NOT NULL,
	"structured_result" jsonb,
	"measured_usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" text,
	"error_message" text,
	"worker_id" text,
	"worktree_id" text,
	"model_route_id" text,
	"permission_profile_id" text,
	"codex_thread_id" text,
	"codex_turn_id" text,
	"starting_revision" text,
	"ending_revision" text,
	"worktree_dirty" boolean,
	"produced_changes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_node_attempts_attempt_check" CHECK ("workflow_node_attempts"."attempt" > 0),
	CONSTRAINT "workflow_node_attempts_status_check" CHECK ("workflow_node_attempts"."status" IN ('queued', 'running', 'waiting-for-approval', 'cancelled', 'failed', 'completed', 'timed-out', 'interrupted', 'orphaned'))
);
--> statement-breakpoint
CREATE TABLE "workflow_revision_edges" (
	"id" text PRIMARY KEY NOT NULL,
	"revision_id" text NOT NULL,
	"from_node_id" text NOT NULL,
	"to_node_id" text NOT NULL,
	"source_output" text,
	"target_input" text,
	"condition" jsonb,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_revision_edges_position_check" CHECK ("workflow_revision_edges"."position" >= 0),
	CONSTRAINT "workflow_revision_edges_not_self_check" CHECK ("workflow_revision_edges"."from_node_id" <> "workflow_revision_edges"."to_node_id")
);
--> statement-breakpoint
CREATE TABLE "workflow_revision_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"revision_id" text NOT NULL,
	"node_key" text NOT NULL,
	"node_type" text NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"configuration" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"input_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"permission_requirements" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"mutation_mode" text DEFAULT 'read-only' NOT NULL,
	"model_route_id" text,
	"permission_profile_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_revision_nodes_position_check" CHECK ("workflow_revision_nodes"."position" >= 0),
	CONSTRAINT "workflow_revision_nodes_mutation_mode_check" CHECK ("workflow_revision_nodes"."mutation_mode" IN ('read-only', 'write'))
);
--> statement-breakpoint
CREATE TABLE "workflow_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"revision" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"declared_inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"declared_outputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"defaults" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"permission_requirements" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" text NOT NULL,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"trust_state" text DEFAULT 'untrusted' NOT NULL,
	"content_hash" text NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_revisions_revision_check" CHECK ("workflow_revisions"."revision" > 0),
	CONSTRAINT "workflow_revisions_trust_state_check" CHECK ("workflow_revisions"."trust_state" IN ('untrusted', 'trusted', 'modified', 'blocked'))
);
--> statement-breakpoint
CREATE TABLE "workflow_run_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"run_node_id" text,
	"attempt_id" text,
	"sequence" integer NOT NULL,
	"event_key" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_run_events_sequence_check" CHECK ("workflow_run_events"."sequence" >= 0)
);
--> statement-breakpoint
CREATE TABLE "workflow_run_node_dependencies" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"revision_edge_id" text,
	"from_node_id" text NOT NULL,
	"to_node_id" text NOT NULL,
	"status" text DEFAULT 'blocked' NOT NULL,
	"result_mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"satisfied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_run_node_dependencies_status_check" CHECK ("workflow_run_node_dependencies"."status" IN ('blocked', 'ready', 'satisfied', 'failed', 'skipped')),
	CONSTRAINT "workflow_run_node_dependencies_not_self_check" CHECK ("workflow_run_node_dependencies"."from_node_id" <> "workflow_run_node_dependencies"."to_node_id")
);
--> statement-breakpoint
CREATE TABLE "workflow_run_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"revision_node_id" text NOT NULL,
	"node_key" text NOT NULL,
	"node_type" text NOT NULL,
	"status" text DEFAULT 'blocked' NOT NULL,
	"dependency_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"structured_input" jsonb NOT NULL,
	"structured_result" jsonb,
	"budget" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"measured_usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"permission_manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"worker_id" text,
	"worktree_id" text,
	"model_route_id" text,
	"permission_profile_id" text,
	"codex_thread_id" text,
	"codex_turn_id" text,
	"write_capable" boolean DEFAULT false NOT NULL,
	"execution_lease_key" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"not_before" timestamp with time zone,
	"timeout_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"waiting_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_run_nodes_status_check" CHECK ("workflow_run_nodes"."status" IN ('blocked', 'ready', 'queued', 'running', 'waiting-for-approval', 'paused', 'cancelling', 'cancelled', 'failed', 'completed', 'retrying', 'recovering', 'skipped')),
	CONSTRAINT "workflow_run_nodes_attempt_count_check" CHECK ("workflow_run_nodes"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"workflow_revision_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"project_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"trigger_type" text DEFAULT 'manual' NOT NULL,
	"trigger_id" text,
	"trigger_provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"structured_input" jsonb NOT NULL,
	"structured_result" jsonb,
	"budget" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"measured_usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"permission_manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"selected_model_route_id" text,
	"selected_permission_profile_id" text,
	"worker_id" text,
	"worktree_id" text,
	"codex_thread_id" text,
	"error_code" text,
	"error_message" text,
	"pause_reason" text,
	"cancel_reason" text,
	"recovery_state" text DEFAULT 'stable' NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"cancel_requested_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_runs_status_check" CHECK ("workflow_runs"."status" IN ('queued', 'running', 'waiting', 'paused', 'cancelling', 'cancelled', 'failed', 'completed', 'recovering')),
	CONSTRAINT "workflow_runs_recovery_state_check" CHECK ("workflow_runs"."recovery_state" IN ('stable', 'pending', 'recovering', 'blocked'))
);
--> statement-breakpoint
ALTER TABLE "workflow_approval_gates" ADD CONSTRAINT "workflow_approval_gates_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_approval_gates" ADD CONSTRAINT "workflow_approval_gates_run_node_id_workflow_run_nodes_id_fk" FOREIGN KEY ("run_node_id") REFERENCES "public"."workflow_run_nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_approval_gates" ADD CONSTRAINT "workflow_approval_gates_interaction_request_id_agent_interaction_requests_id_fk" FOREIGN KEY ("interaction_request_id") REFERENCES "public"."agent_interaction_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_approval_gates" ADD CONSTRAINT "workflow_approval_gates_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD CONSTRAINT "workflow_definitions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD CONSTRAINT "workflow_definitions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_node_attempts" ADD CONSTRAINT "workflow_node_attempts_run_node_id_workflow_run_nodes_id_fk" FOREIGN KEY ("run_node_id") REFERENCES "public"."workflow_run_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_node_attempts" ADD CONSTRAINT "workflow_node_attempts_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_node_attempts" ADD CONSTRAINT "workflow_node_attempts_worktree_id_project_worktrees_id_fk" FOREIGN KEY ("worktree_id") REFERENCES "public"."project_worktrees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_node_attempts" ADD CONSTRAINT "workflow_node_attempts_model_route_id_model_routes_id_fk" FOREIGN KEY ("model_route_id") REFERENCES "public"."model_routes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_revision_edges" ADD CONSTRAINT "workflow_revision_edges_revision_id_workflow_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."workflow_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_revision_edges" ADD CONSTRAINT "workflow_revision_edges_from_node_id_workflow_revision_nodes_id_fk" FOREIGN KEY ("from_node_id") REFERENCES "public"."workflow_revision_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_revision_edges" ADD CONSTRAINT "workflow_revision_edges_to_node_id_workflow_revision_nodes_id_fk" FOREIGN KEY ("to_node_id") REFERENCES "public"."workflow_revision_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_revision_nodes" ADD CONSTRAINT "workflow_revision_nodes_revision_id_workflow_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."workflow_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_revision_nodes" ADD CONSTRAINT "workflow_revision_nodes_model_route_id_model_routes_id_fk" FOREIGN KEY ("model_route_id") REFERENCES "public"."model_routes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_revisions" ADD CONSTRAINT "workflow_revisions_workflow_id_workflow_definitions_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_revisions" ADD CONSTRAINT "workflow_revisions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run_events" ADD CONSTRAINT "workflow_run_events_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run_events" ADD CONSTRAINT "workflow_run_events_run_node_id_workflow_run_nodes_id_fk" FOREIGN KEY ("run_node_id") REFERENCES "public"."workflow_run_nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run_events" ADD CONSTRAINT "workflow_run_events_attempt_id_workflow_node_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."workflow_node_attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run_node_dependencies" ADD CONSTRAINT "workflow_run_node_dependencies_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run_node_dependencies" ADD CONSTRAINT "workflow_run_node_dependencies_revision_edge_id_workflow_revision_edges_id_fk" FOREIGN KEY ("revision_edge_id") REFERENCES "public"."workflow_revision_edges"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run_node_dependencies" ADD CONSTRAINT "workflow_run_node_dependencies_from_node_id_workflow_run_nodes_id_fk" FOREIGN KEY ("from_node_id") REFERENCES "public"."workflow_run_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run_node_dependencies" ADD CONSTRAINT "workflow_run_node_dependencies_to_node_id_workflow_run_nodes_id_fk" FOREIGN KEY ("to_node_id") REFERENCES "public"."workflow_run_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run_nodes" ADD CONSTRAINT "workflow_run_nodes_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run_nodes" ADD CONSTRAINT "workflow_run_nodes_revision_node_id_workflow_revision_nodes_id_fk" FOREIGN KEY ("revision_node_id") REFERENCES "public"."workflow_revision_nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run_nodes" ADD CONSTRAINT "workflow_run_nodes_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run_nodes" ADD CONSTRAINT "workflow_run_nodes_worktree_id_project_worktrees_id_fk" FOREIGN KEY ("worktree_id") REFERENCES "public"."project_worktrees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run_nodes" ADD CONSTRAINT "workflow_run_nodes_model_route_id_model_routes_id_fk" FOREIGN KEY ("model_route_id") REFERENCES "public"."model_routes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflow_id_workflow_definitions_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflow_revision_id_workflow_revisions_id_fk" FOREIGN KEY ("workflow_revision_id") REFERENCES "public"."workflow_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_selected_model_route_id_model_routes_id_fk" FOREIGN KEY ("selected_model_route_id") REFERENCES "public"."model_routes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_worktree_id_project_worktrees_id_fk" FOREIGN KEY ("worktree_id") REFERENCES "public"."project_worktrees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_approval_gates_key_unique" ON "workflow_approval_gates" USING btree ("run_id","gate_key");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_approval_gates_interaction_unique" ON "workflow_approval_gates" USING btree ("interaction_request_id");--> statement-breakpoint
CREATE INDEX "workflow_approval_gates_status_expiry_index" ON "workflow_approval_gates" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_definitions_personal_slug_unique" ON "workflow_definitions" USING btree ("owner_id","slug") WHERE "workflow_definitions"."scope" = 'personal' AND "workflow_definitions"."project_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_definitions_project_slug_unique" ON "workflow_definitions" USING btree ("project_id","slug") WHERE "workflow_definitions"."scope" = 'project' AND "workflow_definitions"."project_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "workflow_definitions_owner_scope_index" ON "workflow_definitions" USING btree ("owner_id","scope","archived_at");--> statement-breakpoint
CREATE INDEX "workflow_definitions_project_index" ON "workflow_definitions" USING btree ("project_id","archived_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_node_attempts_number_unique" ON "workflow_node_attempts" USING btree ("run_node_id","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_node_attempts_idempotency_unique" ON "workflow_node_attempts" USING btree ("run_node_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "workflow_node_attempts_recovery_index" ON "workflow_node_attempts" USING btree ("status","heartbeat_at");--> statement-breakpoint
CREATE INDEX "workflow_revision_edges_from_index" ON "workflow_revision_edges" USING btree ("revision_id","from_node_id","position");--> statement-breakpoint
CREATE INDEX "workflow_revision_edges_to_index" ON "workflow_revision_edges" USING btree ("revision_id","to_node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_revision_nodes_key_unique" ON "workflow_revision_nodes" USING btree ("revision_id","node_key");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_revision_nodes_position_unique" ON "workflow_revision_nodes" USING btree ("revision_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_revisions_workflow_revision_unique" ON "workflow_revisions" USING btree ("workflow_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_revisions_workflow_hash_unique" ON "workflow_revisions" USING btree ("workflow_id","content_hash");--> statement-breakpoint
CREATE INDEX "workflow_revisions_workflow_created_index" ON "workflow_revisions" USING btree ("workflow_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_run_events_sequence_unique" ON "workflow_run_events" USING btree ("run_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_run_events_key_unique" ON "workflow_run_events" USING btree ("run_id","event_key");--> statement-breakpoint
CREATE INDEX "workflow_run_events_node_created_index" ON "workflow_run_events" USING btree ("run_node_id","created_at");--> statement-breakpoint
CREATE INDEX "workflow_run_events_type_created_index" ON "workflow_run_events" USING btree ("type","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_run_node_dependencies_edge_unique" ON "workflow_run_node_dependencies" USING btree ("run_id","from_node_id","to_node_id");--> statement-breakpoint
CREATE INDEX "workflow_run_node_dependencies_target_index" ON "workflow_run_node_dependencies" USING btree ("run_id","to_node_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_run_nodes_key_unique" ON "workflow_run_nodes" USING btree ("run_id","node_key");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_run_nodes_revision_node_unique" ON "workflow_run_nodes" USING btree ("run_id","revision_node_id");--> statement-breakpoint
CREATE INDEX "workflow_run_nodes_status_index" ON "workflow_run_nodes" USING btree ("run_id","status");--> statement-breakpoint
CREATE INDEX "workflow_run_nodes_worker_status_index" ON "workflow_run_nodes" USING btree ("worker_id","status");--> statement-breakpoint
CREATE INDEX "workflow_run_nodes_worktree_status_index" ON "workflow_run_nodes" USING btree ("worktree_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_runs_owner_idempotency_unique" ON "workflow_runs" USING btree ("owner_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "workflow_runs_workflow_created_index" ON "workflow_runs" USING btree ("workflow_id","created_at");--> statement-breakpoint
CREATE INDEX "workflow_runs_project_status_index" ON "workflow_runs" USING btree ("project_id","status","created_at");--> statement-breakpoint
CREATE INDEX "workflow_runs_recovery_index" ON "workflow_runs" USING btree ("recovery_state","updated_at");
