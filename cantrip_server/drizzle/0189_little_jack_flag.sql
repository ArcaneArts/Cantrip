ALTER TABLE "chats" ADD COLUMN "github_item_kind" text;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "github_item_number" integer;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "github_agent_intent" text;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "github_head_sha" text;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_github_agent_context_check" CHECK ((
        "chats"."github_item_kind" IS NULL AND
        "chats"."github_item_number" IS NULL AND
        "chats"."github_agent_intent" IS NULL AND
        "chats"."github_head_sha" IS NULL
      ) OR (
        "chats"."context_kind" = 'project' AND
        "chats"."experience" = 'agent' AND
        "chats"."github_item_kind" IN ('issue', 'pull-request') AND
        "chats"."github_item_number" > 0 AND
        "chats"."github_agent_intent" IN ('start-work', 'address-review', 'fix-checks') AND
        "chats"."github_head_sha" ~ '^[0-9a-f]{40,64}$' AND
        (
          ("chats"."github_item_kind" = 'issue' AND "chats"."github_agent_intent" = 'start-work') OR
          ("chats"."github_item_kind" = 'pull-request' AND "chats"."github_agent_intent" IN ('address-review', 'fix-checks'))
        )
      ));
