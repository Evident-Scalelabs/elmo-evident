CREATE TABLE "acquisition_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"request_hash" text NOT NULL,
	"request" jsonb NOT NULL,
	"producer_revision" text NOT NULL,
	"status" text DEFAULT 'dispatching' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "acquisition_requests" ENABLE ROW LEVEL SECURITY;