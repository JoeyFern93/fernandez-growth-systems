PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  owner_hash TEXT NOT NULL,
  host TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  closed INTEGER NOT NULL DEFAULT 0 CHECK (closed IN (0, 1)),
  created_at TEXT NOT NULL,
  creation_bucket TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reviews_creation_bucket ON reviews(creation_bucket);
CREATE INDEX IF NOT EXISTS reviews_created_at ON reviews(created_at);

CREATE TABLE IF NOT EXISTS review_links (
  review_id TEXT PRIMARY KEY REFERENCES reviews(id) ON DELETE CASCADE,
  invite TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  label TEXT NOT NULL,
  UNIQUE (review_id, url)
);

CREATE TABLE IF NOT EXISTS captures (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  image_data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS captures_review ON captures(review_id);
CREATE INDEX IF NOT EXISTS captures_byte_length ON captures(byte_length);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  capture_id TEXT REFERENCES captures(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  x REAL,
  y REAL,
  name TEXT NOT NULL,
  text TEXT NOT NULL,
  context TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0, 1)),
  UNIQUE (review_id, client_id)
);
CREATE INDEX IF NOT EXISTS notes_created ON notes(review_id, created_at);

CREATE TABLE IF NOT EXISTS capture_attempts (
  attempted_at INTEGER NOT NULL,
  review_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS capture_attempts_time ON capture_attempts(attempted_at);
