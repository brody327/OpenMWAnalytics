CREATE TABLE "mods" (
	"mod_id" text PRIMARY KEY NOT NULL,
	"display_name" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "mod_id" text DEFAULT 'unknown' NOT NULL;