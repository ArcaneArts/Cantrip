CREATE TABLE "agent_interaction_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"request_key" text NOT NULL,
	"project_id" text NOT NULL,
	"chat_id" text,
	"worker_id" text NOT NULL,
	"execution_lane_id" text,
	"thread_id" text NOT NULL,
	"turn_id" text,
	"item_id" text,
	"workflow_run_id" text,
	"workflow_node_id" text,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"payload" jsonb NOT NULL,
	"response" jsonb,
	"resolution_idempotency_key" text,
	"resolved_by_user_id" text,
	"expires_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_interaction_requests" ADD CONSTRAINT "agent_interaction_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_interaction_requests" ADD CONSTRAINT "agent_interaction_requests_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_interaction_requests" ADD CONSTRAINT "agent_interaction_requests_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_interaction_requests" ADD CONSTRAINT "agent_interaction_requests_execution_lane_id_chat_execution_lanes_id_fk" FOREIGN KEY ("execution_lane_id") REFERENCES "public"."chat_execution_lanes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_interaction_requests" ADD CONSTRAINT "agent_interaction_requests_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_interaction_requests_request_key_unique" ON "agent_interaction_requests" USING btree ("request_key");--> statement-breakpoint
CREATE INDEX "agent_interaction_requests_chat_status_index" ON "agent_interaction_requests" USING btree ("chat_id","status");--> statement-breakpoint
CREATE INDEX "agent_interaction_requests_expiry_index" ON "agent_interaction_requests" USING btree ("status","expires_at");