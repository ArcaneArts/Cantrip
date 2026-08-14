ALTER TABLE "chat_messages" ADD COLUMN "reasoning_effort" text;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "applied_reasoning_effort" text;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "reasoning_adjusted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "reasoning_effort" text;--> statement-breakpoint
ALTER TABLE "project_automation_runs" ADD COLUMN "reasoning_effort" text;--> statement-breakpoint
ALTER TABLE "queued_prompts" ADD COLUMN "reasoning_effort" text;--> statement-breakpoint
UPDATE "chats" AS "chat"
SET "reasoning_effort" = COALESCE(
  "profile"."reasoning_effort",
  (
    SELECT "route"."reasoning_effort"
    FROM "model_routes" AS "route"
    WHERE "route"."model_id" = "chat"."model_id"
      AND "route"."enabled" = true
      AND "route"."reasoning_effort" IS NOT NULL
    ORDER BY "route"."position"
    LIMIT 1
  )
)
FROM "model_profiles" AS "profile"
WHERE "profile"."id" = "chat"."model_id";--> statement-breakpoint
UPDATE "queued_prompts" AS "prompt"
SET "reasoning_effort" = "chat"."reasoning_effort"
FROM "chats" AS "chat"
WHERE "chat"."id" = "prompt"."chat_id";--> statement-breakpoint
UPDATE "chat_messages" AS "message"
SET
  "reasoning_effort" = COALESCE(
    (SELECT "route"."reasoning_effort" FROM "model_routes" AS "route" WHERE "route"."id" = "message"."model_route_id"),
    "profile"."reasoning_effort"
  ),
  "applied_reasoning_effort" = COALESCE(
    (SELECT "route"."reasoning_effort" FROM "model_routes" AS "route" WHERE "route"."id" = "message"."model_route_id"),
    "profile"."reasoning_effort"
  )
FROM "model_profiles" AS "profile"
WHERE "profile"."id" = "message"."model_id";--> statement-breakpoint
UPDATE "project_automation_runs" AS "run"
SET "reasoning_effort" = "chat"."reasoning_effort"
FROM "chats" AS "chat"
WHERE "chat"."id" = "run"."chat_id";
