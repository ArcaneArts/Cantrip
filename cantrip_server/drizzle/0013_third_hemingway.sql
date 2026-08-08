CREATE TABLE "model_routes" (
	"id" text PRIMARY KEY NOT NULL,
	"model_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"model_name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"reasoning_effort" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "model_routes" (
	"id",
	"model_id",
	"provider_id",
	"model_name",
	"position",
	"enabled",
	"reasoning_effort"
)
SELECT
	CASE
		WHEN "id" = '00000000-0000-0000-0000-000000000020'
			THEN '00000000-0000-0000-0000-000000000021'
		ELSE "id" || ':route:0'
	END,
	"id",
	"provider_id",
	"name",
	0,
	true,
	NULL
FROM "model_profiles";
--> statement-breakpoint
ALTER TABLE "model_profiles" DROP CONSTRAINT "model_profiles_provider_id_model_providers_id_fk";
--> statement-breakpoint
DROP INDEX "model_profiles_owner_provider_name_unique";--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "model_id" text;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "model_route_id" text;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "provider_id" text;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "provider_name" text;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "provider_model_name" text;--> statement-breakpoint
ALTER TABLE "chat_runtime_sessions" ADD COLUMN "model_route_id" text;--> statement-breakpoint
ALTER TABLE "model_profiles" ADD COLUMN "routing_policy" text DEFAULT 'priority' NOT NULL;--> statement-breakpoint
UPDATE "chat_runtime_sessions" AS runtime
SET "model_route_id" = route."id"
FROM "chats" AS chat
INNER JOIN "model_routes" AS route ON route."model_id" = chat."model_id"
WHERE runtime."chat_id" = chat."id";
--> statement-breakpoint
ALTER TABLE "model_routes" ADD CONSTRAINT "model_routes_model_id_model_profiles_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."model_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_routes" ADD CONSTRAINT "model_routes_provider_id_model_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."model_providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "model_routes_model_position_unique" ON "model_routes" USING btree ("model_id","position");--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_model_id_model_profiles_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."model_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_model_route_id_model_routes_id_fk" FOREIGN KEY ("model_route_id") REFERENCES "public"."model_routes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_provider_id_model_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."model_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_runtime_sessions" ADD CONSTRAINT "chat_runtime_sessions_model_route_id_model_routes_id_fk" FOREIGN KEY ("model_route_id") REFERENCES "public"."model_routes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_profiles" DROP COLUMN "provider_id";
