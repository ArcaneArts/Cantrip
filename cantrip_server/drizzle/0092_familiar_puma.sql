CREATE TABLE "task_planning_rounds" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"input_brief_markdown" text NOT NULL,
	"input_plan_markdown" text,
	"input_questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"input_answers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"additional_direction" text DEFAULT '' NOT NULL,
	"output_plan_markdown" text,
	"output_questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"output_goal_prompt" text,
	"user_message_id" text,
	"assistant_message_id" text,
	"execution_lane_id" text,
	"turn_id" text,
	"error" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "task_planning_rounds_ordinal_check" CHECK ("task_planning_rounds"."ordinal" >= 0),
	CONSTRAINT "task_planning_rounds_kind_check" CHECK ("task_planning_rounds"."kind" IN ('initial-plan', 'continue-plan', 'finalize')),
	CONSTRAINT "task_planning_rounds_status_check" CHECK ("task_planning_rounds"."status" IN ('running', 'completed', 'failed', 'interrupted')),
	CONSTRAINT "task_planning_rounds_input_brief_length_check" CHECK (length("task_planning_rounds"."input_brief_markdown") <= 100000),
	CONSTRAINT "task_planning_rounds_input_plan_length_check" CHECK ("task_planning_rounds"."input_plan_markdown" IS NULL OR length("task_planning_rounds"."input_plan_markdown") <= 100000),
	CONSTRAINT "task_planning_rounds_output_plan_length_check" CHECK ("task_planning_rounds"."output_plan_markdown" IS NULL OR length("task_planning_rounds"."output_plan_markdown") <= 100000),
	CONSTRAINT "task_planning_rounds_goal_prompt_length_check" CHECK ("task_planning_rounds"."output_goal_prompt" IS NULL OR length("task_planning_rounds"."output_goal_prompt") <= 100000),
	CONSTRAINT "task_planning_rounds_direction_length_check" CHECK (length("task_planning_rounds"."additional_direction") <= 10000)
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"chat_id" text PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"stable_state_before_failure" text,
	"active_operation_id" text,
	"active_operation_kind" text,
	"brief_markdown" text DEFAULT '' NOT NULL,
	"draft_attachment_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"plan_markdown" text,
	"plan_authorship" text DEFAULT 'agent' NOT NULL,
	"current_questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"current_answers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"additional_direction" text DEFAULT '' NOT NULL,
	"final_plan_markdown" text,
	"goal_prompt" text,
	"planning_round" integer DEFAULT 0 NOT NULL,
	"implementation_started_at" timestamp with time zone,
	"last_error" jsonb,
	"row_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_state_check" CHECK ("tasks"."state" IN ('draft', 'planning', 'review', 'finalizing', 'implementing', 'paused', 'blocked', 'complete', 'failed')),
	CONSTRAINT "tasks_stable_failure_state_check" CHECK ("tasks"."stable_state_before_failure" IS NULL OR "tasks"."stable_state_before_failure" IN ('draft', 'review')),
	CONSTRAINT "tasks_active_operation_kind_check" CHECK ("tasks"."active_operation_kind" IS NULL OR "tasks"."active_operation_kind" IN ('initial-plan', 'continue-plan', 'finalize')),
	CONSTRAINT "tasks_active_operation_pair_check" CHECK (("tasks"."active_operation_id" IS NULL) = ("tasks"."active_operation_kind" IS NULL)),
	CONSTRAINT "tasks_plan_authorship_check" CHECK ("tasks"."plan_authorship" IN ('agent', 'user-edited', 'mixed')),
	CONSTRAINT "tasks_brief_length_check" CHECK (length("tasks"."brief_markdown") <= 100000),
	CONSTRAINT "tasks_plan_length_check" CHECK ("tasks"."plan_markdown" IS NULL OR length("tasks"."plan_markdown") BETWEEN 1 AND 100000),
	CONSTRAINT "tasks_final_plan_length_check" CHECK ("tasks"."final_plan_markdown" IS NULL OR length("tasks"."final_plan_markdown") BETWEEN 1 AND 100000),
	CONSTRAINT "tasks_goal_prompt_length_check" CHECK ("tasks"."goal_prompt" IS NULL OR length("tasks"."goal_prompt") BETWEEN 1 AND 100000),
	CONSTRAINT "tasks_direction_length_check" CHECK (length("tasks"."additional_direction") <= 10000),
	CONSTRAINT "tasks_planning_round_check" CHECK ("tasks"."planning_round" >= 0),
	CONSTRAINT "tasks_row_version_check" CHECK ("tasks"."row_version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "experience" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "task_planning_rounds" ADD CONSTRAINT "task_planning_rounds_chat_id_tasks_chat_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."tasks"("chat_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_planning_rounds" ADD CONSTRAINT "task_planning_rounds_user_message_id_chat_messages_id_fk" FOREIGN KEY ("user_message_id") REFERENCES "public"."chat_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_planning_rounds" ADD CONSTRAINT "task_planning_rounds_assistant_message_id_chat_messages_id_fk" FOREIGN KEY ("assistant_message_id") REFERENCES "public"."chat_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_planning_rounds" ADD CONSTRAINT "task_planning_rounds_execution_lane_id_chat_execution_lanes_id_fk" FOREIGN KEY ("execution_lane_id") REFERENCES "public"."chat_execution_lanes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_planning_rounds_chat_ordinal_unique" ON "task_planning_rounds" USING btree ("chat_id","ordinal");--> statement-breakpoint
CREATE INDEX "task_planning_rounds_chat_started_index" ON "task_planning_rounds" USING btree ("chat_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_active_operation_unique" ON "tasks" USING btree ("active_operation_id") WHERE "tasks"."active_operation_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_experience_check" CHECK ("chats"."experience" IN ('agent', 'task'));