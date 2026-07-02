-- Local mirror of Lodgify bookings, synced by the 30-min poll cron.
--
-- Why: Lodgify rate-limits this (unregistered) integration, so hitting its API
-- on every conciliação page load returns 429s. The poll already fetches
-- bookings from Lodgify in the background; it now upserts them here so the
-- reconciliation view reads from D1 (instant, no Lodgify call, no 429). All
-- Lodgify traffic is isolated to the background cron.
--
-- Additive/idempotent: IF NOT EXISTS so re-running is safe.

CREATE TABLE IF NOT EXISTS lodgify_bookings (
  id            TEXT PRIMARY KEY,   -- Lodgify booking id
  user_id       TEXT NOT NULL,      -- owning connection user
  status        TEXT,               -- Booked | Open | Declined | ...
  amount_due    REAL,               -- outstanding balance in Lodgify (0 ⇒ paid)
  amount_paid   REAL,
  total_amount  REAL,
  currency_code TEXT,
  arrival       TEXT,               -- YYYY-MM-DD
  departure     TEXT,               -- YYYY-MM-DD
  created_at    TEXT,               -- booking created (ISO, from Lodgify)
  updated_at    TEXT,               -- booking last modified (ISO, from Lodgify)
  source        TEXT,               -- OTA channel (BookingCom | Airbnb | Manual | ...)
  property_id   TEXT,
  guest_name    TEXT,
  guest_email   TEXT,
  raw_json      TEXT,               -- full v2 booking item (source of truth for reads)
  synced_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_lodgify_bookings_user_created
  ON lodgify_bookings(user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_lodgify_bookings_user_arrival
  ON lodgify_bookings(user_id, arrival);
