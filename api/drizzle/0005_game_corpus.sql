-- HAND-ADDED: drizzle-kit generates DDL from schema.ts and has no concept of extensions, so
-- it emits `vector(384)` without ever creating the type. On a fresh database this migration
-- fails at the first CREATE TABLE.
--
-- It belongs in the migration rather than a manual psql step because the deploy path is the
-- initContainer (09 §7), and the standing lesson from the prod-500 incident is that anything
-- the app requires but the migration does not create is a 500 waiting for the next fresh
-- environment.
--
-- Verified 2026-07-26 that the RDS parameter group permits this (tested inside a transaction
-- and rolled back): pgvector 0.8.2 available on prod, 0.8.5 locally. 0.8+ matters -- iterative
-- index scans, the escape hatch for middle-selectivity filtered queries (11 §7), exist only
-- from 0.8.0.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "game_chunks" (
	"chunk_id" text PRIMARY KEY NOT NULL,
	"record_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"text" text NOT NULL,
	"embedding" vector(384),
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
	"text_hash" text NOT NULL,
	"embedding_model" text,
	"embedding_dims" smallint,
	CONSTRAINT "game_chunks_embedding_provenance_ck" CHECK (("game_chunks"."embedding" IS NULL) = ("game_chunks"."embedding_model" IS NULL)
          AND ("game_chunks"."embedding" IS NULL) = ("game_chunks"."embedding_dims" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "game_records" (
	"record_id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"type" text NOT NULL,
	"name" text,
	"full_text" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "record_effects" (
	"record_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"effect_id" integer NOT NULL,
	"effect_name" text NOT NULL,
	"affected" text,
	"affected_kind" text,
	"magnitude_min" integer,
	"magnitude_max" integer,
	"duration" integer,
	"range" text,
	CONSTRAINT "record_effects_record_id_ordinal_pk" PRIMARY KEY("record_id","ordinal")
);
--> statement-breakpoint
ALTER TABLE "game_chunks" ADD CONSTRAINT "game_chunks_record_id_game_records_record_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."game_records"("record_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_effects" ADD CONSTRAINT "record_effects_record_id_game_records_record_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."game_records"("record_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "game_chunks_record_idx" ON "game_chunks" USING btree ("record_id","ordinal");--> statement-breakpoint
CREATE INDEX "game_chunks_tsv_idx" ON "game_chunks" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "game_chunks_embedding_hnsw_idx" ON "game_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "game_records_type_idx" ON "game_records" USING btree ("type","source");--> statement-breakpoint
CREATE INDEX "record_effects_affected_idx" ON "record_effects" USING btree ("affected","magnitude_min");