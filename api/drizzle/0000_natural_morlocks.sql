CREATE TABLE "events" (
	"session_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"install_id" uuid NOT NULL,
	"type" text NOT NULL,
	"v" smallint NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"env" text DEFAULT 'prod' NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"suspect" text GENERATED ALWAYS AS (data->>'suspect') STORED,
	"topic" text GENERATED ALWAYS AS (data->>'topic') STORED,
	"reason" text GENERATED ALWAYS AS (data->>'reason') STORED,
	"passed" boolean GENERATED ALWAYS AS ((data->>'passed')::boolean) STORED,
	CONSTRAINT "events_session_id_seq_pk" PRIMARY KEY("session_id","seq")
);
--> statement-breakpoint
CREATE TABLE "friction_attempts_rollup" (
	"session_id" uuid NOT NULL,
	"install_id" uuid NOT NULL,
	"suspect" text NOT NULL,
	"topic" text NOT NULL,
	"total_attempts" integer NOT NULL,
	"attempts_to_pass" integer,
	CONSTRAINT "friction_attempts_rollup_session_id_suspect_topic_pk" PRIMARY KEY("session_id","suspect","topic")
);
--> statement-breakpoint
CREATE TABLE "friction_rollup" (
	"suspect" text NOT NULL,
	"topic" text NOT NULL,
	"next_action" text NOT NULL,
	"count" integer NOT NULL,
	"gap_count" integer NOT NULL,
	"sum_gap_seconds" double precision NOT NULL,
	CONSTRAINT "friction_rollup_suspect_topic_next_action_pk" PRIMARY KEY("suspect","topic","next_action")
);
--> statement-breakpoint
CREATE TABLE "friction_sessions_done" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"rolled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "events_type_ts_idx" ON "events" USING btree ("type","ts");--> statement-breakpoint
CREATE INDEX "events_confrontation_cols_idx" ON "events" USING btree ("suspect","topic","passed") WHERE type = 'ConfrontationAttempted';--> statement-breakpoint
CREATE INDEX "events_confrontation_reason_idx" ON "events" USING btree ("passed","reason") WHERE type = 'ConfrontationAttempted';