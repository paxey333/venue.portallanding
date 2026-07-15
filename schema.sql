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

-- Commit Z: events table (applied via migration)
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  presenter TEXT,
  host_type TEXT NOT NULL DEFAULT 'platform'
    CHECK(host_type IN ('platform','venue','promoter')),
  host_id INTEGER,
  venue_id INTEGER REFERENCES venues(id) ON DELETE SET NULL,
  venue_name_public TEXT,
  city TEXT,
  address_private TEXT,
  event_date TEXT NOT NULL,
  doors_time TEXT,
  description TEXT,
  performers TEXT,
  team TEXT,
  accent_color TEXT DEFAULT '#ff6b1a',
  hero_image_url TEXT,
  ticketing_provider TEXT NOT NULL DEFAULT 'hi_events'
    CHECK(ticketing_provider IN ('hi_events','external','native')),
  ticketing_url TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK(status IN ('draft','published','past','cancelled')),
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_slug ON events(slug);
CREATE INDEX IF NOT EXISTS idx_events_venue_date ON events(venue_id, event_date);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);

-- Commit Z intent note -- NOT applied. Native ticketing tables, built when
-- ticketing_provider='native' is real (i.e. when Hi.Events stops being enough):
-- ticket_types (id, event_id FK, name, price_cents, quantity, sales_end)
-- tickets (id, event_id FK, ticket_type_id FK, buyer_name, buyer_email,
--          payment_provider CHECK IN ('stripe','aeropay'), payment_ref,
--          status, created_at)
-- Tickets reference events, never venues -- locked by design.

-- Commit AE: API tokens for automation auth (applied via migration)
-- CREATE TABLE IF NOT EXISTS api_tokens (
--   id INTEGER PRIMARY KEY AUTOINCREMENT,
--   token_hash TEXT NOT NULL UNIQUE,
--   name TEXT NOT NULL,
--   role TEXT NOT NULL CHECK(role IN ('admin','superadmin')),
--   created_by INTEGER,
--   created_at TEXT NOT NULL DEFAULT (datetime('now')),
--   last_used_at TEXT,
--   revoked INTEGER NOT NULL DEFAULT 0
-- );