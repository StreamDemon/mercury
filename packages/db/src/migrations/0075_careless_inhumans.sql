ALTER TABLE "companies" ALTER COLUMN "issue_prefix" SET DEFAULT 'MERC';--> statement-breakpoint
ALTER TABLE "feedback_exports" ALTER COLUMN "schema_version" SET DEFAULT 'mercury-feedback-envelope-v2';--> statement-breakpoint
ALTER TABLE "feedback_exports" ALTER COLUMN "bundle_version" SET DEFAULT 'mercury-feedback-bundle-v2';--> statement-breakpoint
ALTER TABLE "feedback_exports" ALTER COLUMN "payload_version" SET DEFAULT 'mercury-feedback-v1';