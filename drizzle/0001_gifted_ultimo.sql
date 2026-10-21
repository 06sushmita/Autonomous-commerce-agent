CREATE TYPE "public"."budget_reservation_status" AS ENUM('active', 'committed', 'released', 'expired');--> statement-breakpoint
CREATE TABLE "budget_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reservation_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"mandate_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"status" "budget_reservation_status" DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"committed_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"release_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_reservations_reservation_id_unique" UNIQUE("reservation_id")
);
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_budget_reservations_user_status" ON "budget_reservations" USING btree ("user_id","status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_budget_reservations_mandate" ON "budget_reservations" USING btree ("mandate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_transactions_idempotency_key" ON "transactions" USING btree ("idempotency_key");--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_idempotency_key_unique" UNIQUE("idempotency_key");