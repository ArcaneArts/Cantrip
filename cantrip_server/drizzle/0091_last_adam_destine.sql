CREATE TABLE "policies" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"summary" text NOT NULL,
	"body_markdown" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"mandatory" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"template_key" text,
	"row_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policies_key_length_check" CHECK (length("policies"."key") BETWEEN 1 AND 80),
	CONSTRAINT "policies_key_format_check" CHECK ("policies"."key" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "policies_name_length_check" CHECK (length(btrim("policies"."name")) BETWEEN 1 AND 120),
	CONSTRAINT "policies_summary_length_check" CHECK (length(btrim("policies"."summary")) BETWEEN 1 AND 1000),
	CONSTRAINT "policies_body_length_check" CHECK (length("policies"."body_markdown") BETWEEN 1 AND 100000),
	CONSTRAINT "policies_position_check" CHECK ("policies"."position" >= 0),
	CONSTRAINT "policies_row_version_check" CHECK ("policies"."row_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "policy_owner_states" (
	"owner_id" text PRIMARY KEY NOT NULL,
	"bootstrap_version" integer DEFAULT 0 NOT NULL,
	"collection_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policy_owner_states_bootstrap_version_check" CHECK ("policy_owner_states"."bootstrap_version" >= 0),
	CONSTRAINT "policy_owner_states_collection_version_check" CHECK ("policy_owner_states"."collection_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "project_policy_assignments" (
	"policy_id" text NOT NULL,
	"project_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_policy_assignments_policy_id_project_id_pk" PRIMARY KEY("policy_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "workspace_policy_assignments" (
	"policy_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_policy_assignments_policy_id_workspace_id_pk" PRIMARY KEY("policy_id","workspace_id")
);
--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_owner_states" ADD CONSTRAINT "policy_owner_states_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_policy_assignments" ADD CONSTRAINT "project_policy_assignments_policy_id_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_policy_assignments" ADD CONSTRAINT "project_policy_assignments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_policy_assignments" ADD CONSTRAINT "workspace_policy_assignments_policy_id_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_policy_assignments" ADD CONSTRAINT "workspace_policy_assignments_workspace_id_project_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."project_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "policies_owner_key_unique" ON "policies" USING btree ("owner_id","key");--> statement-breakpoint
CREATE INDEX "policies_owner_position_index" ON "policies" USING btree ("owner_id","position","key");--> statement-breakpoint
CREATE INDEX "project_policy_assignments_project_index" ON "project_policy_assignments" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "workspace_policy_assignments_workspace_index" ON "workspace_policy_assignments" USING btree ("workspace_id");--> statement-breakpoint
INSERT INTO "policy_owner_states" (
	"owner_id", "bootstrap_version", "collection_version"
)
SELECT "id", 1, 1
FROM "users"
ON CONFLICT ("owner_id") DO NOTHING;--> statement-breakpoint
INSERT INTO "policies" (
	"id", "owner_id", "key", "name", "summary", "body_markdown",
	"enabled", "mandatory", "position", "template_key", "row_version"
)
SELECT
	'policy:manual-change-protocol:' || "id",
	"id",
	'manual-change-protocol',
	'Manual Change Protocol',
	'Use an isolated worktree and independently merged pull request for every manual repository change. Read the full policy before changing files or Git state with `cantrip policy read manual-change-protocol`.',
	$policy$# Manual Change Protocol

Use this policy whenever a user asks you to change a repository without an
existing tracked workflow that defines another delivery process.

## Delivery requirements

1. Before editing, inspect repository status, applicable AGENTS.md and policy
   instructions, upstream state, active branches and worktrees, and overlapping
   pull requests or change lanes.
2. Preserve unrelated and user-owned work. Never clean, move, reset, adopt, or
   combine changes that do not belong to the request.
3. Create a dedicated branch in an isolated worktree from the appropriate
   current upstream branch. Do not implement directly in the primary checkout.
4. Keep the change independently reviewable and mergeable. Split large goals
   into sequential milestones rather than accumulating them on one long-lived
   branch.
5. Follow the repository's contribution instructions and architecture. Run the
   formatting, tests, builds, and other checks proportional to the change, and
   report only validation that actually ran.
6. Push the isolated branch and open a ready pull request with an accurate
   summary and validation report.
7. Enable squash auto-merge when the repository supports it, then observe the
   pull request until it merges. Resolve failures or conflicts only in the
   isolated branch and never bypass repository protections.
8. After merge, safely synchronize the primary checkout when it is clean and
   remove only the worktree and branch created for this change.

For every additional dependent milestone, begin again from the latest upstream
state and repeat the complete worktree, pull request, merge-observation, and
cleanup cycle.$policy$,
	true,
	true,
	0,
	'manual-change-protocol',
	1
FROM "users"
ON CONFLICT ("owner_id", "key") DO NOTHING;
