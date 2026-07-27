CREATE TABLE "shipper_state" (
	"install_id" uuid PRIMARY KEY NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_shipped_seq" integer,
	"shipper_version" text
);
