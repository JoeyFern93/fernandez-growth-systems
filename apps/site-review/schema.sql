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

CREATE TABLE IF NOT EXISTS capture_image_parts (
  capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
  tile_index INTEGER NOT NULL,
  part_index INTEGER NOT NULL,
  image_data TEXT NOT NULL,
  PRIMARY KEY(capture_id, tile_index, part_index)
) WITHOUT ROWID;

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


CREATE TABLE IF NOT EXISTS replay_pairs (
  id TEXT PRIMARY KEY,
  tv_hash TEXT NOT NULL,
  invite_hash TEXT,
  phone_hash TEXT,
  bucket TEXT NOT NULL,
  expires INTEGER NOT NULL,
  ended INTEGER NOT NULL DEFAULT 0,
  offer TEXT,
  answer TEXT
);
CREATE INDEX IF NOT EXISTS replay_pairs_expiry ON replay_pairs(expires);

CREATE TABLE IF NOT EXISTS replay_pair_ice (
      id TEXT NOT NULL REFERENCES replay_pairs(id) ON DELETE CASCADE,
      role TEXT NOT NULL, revision INTEGER NOT NULL, candidates TEXT NOT NULL, complete INTEGER NOT NULL,
      PRIMARY KEY(id,role)) WITHOUT ROWID;

CREATE TRIGGER IF NOT EXISTS replay_clear_ice AFTER UPDATE OF ended ON replay_pairs WHEN NEW.ended=1 BEGIN
      DELETE FROM replay_pair_ice WHERE id=NEW.id; END;

CREATE TABLE IF NOT EXISTS replay_relays (
     id TEXT PRIMARY KEY REFERENCES replay_pairs(id) ON DELETE CASCADE, status TEXT NOT NULL,
     formats TEXT NOT NULL, mime TEXT, latest INTEGER NOT NULL DEFAULT -1,
     last_at INTEGER NOT NULL DEFAULT 0, expires INTEGER NOT NULL, writer TEXT);

CREATE TABLE IF NOT EXISTS replay_relay_chunks (
     pair_id TEXT NOT NULL REFERENCES replay_relays(id) ON DELETE CASCADE,
     slot INTEGER NOT NULL, seq INTEGER NOT NULL, ciphertext TEXT NOT NULL, reads INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY(pair_id,slot)) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS replay_relay_days (day INTEGER PRIMARY KEY,packets INTEGER NOT NULL,bytes INTEGER NOT NULL);

CREATE TRIGGER IF NOT EXISTS replay_erase_ended AFTER UPDATE OF ended ON replay_pairs WHEN NEW.ended=1 BEGIN
     DELETE FROM replay_relay_chunks WHERE pair_id=NEW.id;
     UPDATE replay_relays SET status='ended',writer=NULL WHERE id=NEW.id AND status<>'ended';
   END;

CREATE TRIGGER IF NOT EXISTS replay_erase_expired AFTER DELETE ON replay_pairs BEGIN
     DELETE FROM replay_relay_chunks WHERE pair_id=OLD.id;
     DELETE FROM replay_relays WHERE id=OLD.id;
   END;
