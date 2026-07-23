CREATE TABLE "friction_fold_state" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sessions_folded" integer DEFAULT 0 NOT NULL
);
