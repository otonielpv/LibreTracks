-- Share tokens for the private product dashboard.
--
-- Until now the dashboard had exactly one credential: the ANALYTICS_ADMIN_TOKEN
-- Pages secret. Handing that to anyone who asks to see the numbers also hands
-- them the ability to mint credentials, and it cannot be taken back without
-- rotating the secret and locking out the maintainer too.
--
-- A row here is a second-class credential: read-only, revocable one at a time,
-- and optionally time-limited. Only the SHA-256 of the token is stored, so a
-- copy of this table is not a set of working passwords; the plaintext exists
-- once, in the response to the request that created it.
CREATE TABLE IF NOT EXISTS analytics_access_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  -- NULL means the token never expires. Deliberately allowed: some people need
  -- standing access, and the alternative is a date so far out it is a lie.
  -- Those tokens are still revocable, which is what actually bounds the risk.
  expires_at INTEGER,
  last_used_at INTEGER,
  use_count INTEGER NOT NULL DEFAULT 0
);

-- Every authenticated request looks a token up by hash, so this is the hot path.
CREATE UNIQUE INDEX IF NOT EXISTS analytics_access_tokens_hash
  ON analytics_access_tokens(token_hash);

CREATE INDEX IF NOT EXISTS analytics_access_tokens_created
  ON analytics_access_tokens(created_at);
