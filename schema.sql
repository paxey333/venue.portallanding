CREATE TABLE IF NOT EXISTS venues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  capacity INTEGER,
  price_per_day REAL,
  image_url TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  venue_id INTEGER,
  client_name TEXT NOT NULL,
  client_email TEXT NOT NULL,
  event_date TEXT NOT NULL,
  guests INTEGER,
  message TEXT,
  status TEXT DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_bookings_venue_id ON bookings (venue_id);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings (status);

-- first_login flag for password-change prompt on first login (applied via migration)
-- ALTER TABLE users ADD COLUMN first_login INTEGER NOT NULL DEFAULT 1;

-- Address columns (applied via migration)
-- ALTER TABLE venues ADD COLUMN address TEXT;
-- ALTER TABLE venues ADD COLUMN city TEXT;
-- ALTER TABLE venues ADD COLUMN state TEXT;

-- Stripe Connect columns (applied via migration)
-- ALTER TABLE venues ADD COLUMN stripe_account_id TEXT;
-- ALTER TABLE venues ADD COLUMN stripe_connected INTEGER DEFAULT 0;

-- Payment flow columns (applied via migration)
-- ALTER TABLE bookings ADD COLUMN payment_link TEXT;
-- ALTER TABLE bookings ADD COLUMN stripe_session_id TEXT;
-- ALTER TABLE bookings ADD COLUMN total_amount INTEGER DEFAULT 50000;
-- ALTER TABLE bookings ADD COLUMN platform_fee INTEGER DEFAULT 5000;

-- Calendar Phase 1: time slots on bookings (applied via migration)
-- ALTER TABLE bookings ADD COLUMN event_time_start TEXT;
-- ALTER TABLE bookings ADD COLUMN event_time_end TEXT;

-- Calendar Phase 1: manual venue blocks (applied via migration)
-- CREATE TABLE IF NOT EXISTS venue_blocks (
--   id INTEGER PRIMARY KEY AUTOINCREMENT,
--   venue_id INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
--   block_date TEXT NOT NULL,
--   time_start TEXT,
--   time_end TEXT,
--   reason TEXT NOT NULL DEFAULT 'Blocked',
--   created_at TEXT NOT NULL DEFAULT (datetime('now'))
-- );
-- CREATE INDEX IF NOT EXISTS idx_venue_blocks_venue_date ON venue_blocks(venue_id, block_date);

-- Phase 2A: iCal feed tokens (applied via migration)
-- CREATE TABLE IF NOT EXISTS calendar_tokens (
--   id INTEGER PRIMARY KEY AUTOINCREMENT,
--   venue_id INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
--   token TEXT NOT NULL UNIQUE,
--   label TEXT NOT NULL DEFAULT 'Default',
--   created_at TEXT NOT NULL DEFAULT (datetime('now'))
-- );
-- CREATE INDEX IF NOT EXISTS idx_calendar_tokens_token ON calendar_tokens(token);
-- CREATE INDEX IF NOT EXISTS idx_calendar_tokens_venue ON calendar_tokens(venue_id);

-- Phase 2B.1: recurring availability rules (applied via migration)
-- CREATE TABLE IF NOT EXISTS venue_availability_rules (
--   id INTEGER PRIMARY KEY AUTOINCREMENT,
--   venue_id INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
--   day_of_week INTEGER NOT NULL CHECK(day_of_week >= 0 AND day_of_week <= 6),
--   time_start TEXT,
--   time_end TEXT,
--   is_open INTEGER NOT NULL DEFAULT 1,
--   created_at TEXT NOT NULL DEFAULT (datetime('now')),
--   UNIQUE(venue_id, day_of_week)
-- );
-- CREATE INDEX IF NOT EXISTS idx_venue_avail_rules_venue ON venue_availability_rules(venue_id);

-- Phase 2C: auto-expiring inquiries (applied via migration)
-- ALTER TABLE bookings ADD COLUMN expires_at TEXT;
-- UPDATE bookings SET expires_at = datetime(created_at, '+7 days') WHERE status = 'pending' AND expires_at IS NULL;
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT    NOT NULL UNIQUE,
  password    TEXT    NOT NULL,
  role        TEXT    NOT NULL CHECK(role IN ('superadmin','admin','venue_owner')),
  venue_id    INTEGER REFERENCES venues(id) ON DELETE SET NULL,
  name        TEXT    NOT NULL DEFAULT '',
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);