-- Replace magic-link auth with password auth (spec: "Auth: email
-- magic-link or simple credentialed login; no SSO needed. Keep it
-- boring."). Additive plus a drop, per the operating constraint not to
-- touch the rest of the schema: adds User.passwordHash (nullable so this
-- applies cleanly to existing rows -- cli:seed-users backfills it) and
-- drops MagicLinkToken, which no longer has any code path writing or
-- reading it.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "passwordHash" TEXT;

-- DropTable
DROP TABLE "MagicLinkToken";
