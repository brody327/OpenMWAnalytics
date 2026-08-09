CREATE TABLE "insights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"check_id" text NOT NULL,
	"stat" text NOT NULL,
	"threshold" integer NOT NULL,
	"headline" text NOT NULL,
	"signposting" text NOT NULL,
	"rationale" text NOT NULL,
	"recommendation" text NOT NULL,
	"citations" jsonb NOT NULL,
	"model" text NOT NULL,
	"prompt_version" integer NOT NULL,
	"evidence" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"review_note" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "insights_status_ck" CHECK ("insights"."status" in ('pending', 'approved', 'rejected')),
	CONSTRAINT "insights_signposting_ck" CHECK ("insights"."signposting" in ('SIGNPOSTED', 'NOT_SIGNPOSTED', 'UNCLEAR'))
);
--> statement-breakpoint
CREATE INDEX "insights_check_status_idx" ON "insights" USING btree ("check_id","status","created_at");--> statement-breakpoint
CREATE INDEX "insights_status_created_idx" ON "insights" USING btree ("status","created_at");