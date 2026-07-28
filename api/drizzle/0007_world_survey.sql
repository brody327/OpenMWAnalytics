CREATE TABLE "item_placements" (
	"area" text NOT NULL,
	"is_exterior" boolean NOT NULL,
	"item_record_id" text NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "item_placements_area_item_record_id_pk" PRIMARY KEY("area","item_record_id")
);
--> statement-breakpoint
CREATE TABLE "world_surveys" (
	"survey_id" text PRIMARY KEY NOT NULL,
	"load_order" jsonb NOT NULL,
	"load_order_hash" text NOT NULL,
	"cells_scanned" integer NOT NULL,
	"surveyed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "item_placements_item_idx" ON "item_placements" USING btree ("item_record_id");