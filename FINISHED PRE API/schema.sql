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
