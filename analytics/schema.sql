-- FlowBatch usage stats. No IP addresses, prompts, file names or URLs are stored.

-- One row per install: a random ID the extension makes, the country Cloudflare saw, the version.
CREATE TABLE IF NOT EXISTS users (
  uid TEXT PRIMARY KEY,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'XX',
  version TEXT NOT NULL DEFAULT ''
);

-- One row per install per day it was used: unique active users, and a per-day event cap.
CREATE TABLE IF NOT EXISTS active (
  day TEXT NOT NULL,
  uid TEXT NOT NULL,
  events INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, uid)
);

-- Daily totals per event ("result" / "gemini-video", "frames" / "tab", …).
CREATE TABLE IF NOT EXISTS counts (
  day TEXT NOT NULL,
  event TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, event, detail)
);

CREATE INDEX IF NOT EXISTS users_country ON users (country);
