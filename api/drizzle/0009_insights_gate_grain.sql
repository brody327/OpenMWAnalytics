DROP INDEX "insights_check_status_idx";--> statement-breakpoint
ALTER TABLE "insights" ADD COLUMN "stat_kind" text NOT NULL;--> statement-breakpoint
CREATE INDEX "insights_gate_status_idx" ON "insights" USING btree ("check_id","stat","stat_kind","threshold","status","created_at");