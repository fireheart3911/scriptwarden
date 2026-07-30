-- ScriptWarden schema. Applied on every boot with IF NOT EXISTS, so it doubles
-- as the migration for a fresh database.

CREATE TABLE IF NOT EXISTS productions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT    NOT NULL,
  osc_ip          TEXT    NOT NULL DEFAULT '',
  osc_port        INTEGER NOT NULL DEFAULT 8000,
  osc_protocol    TEXT    NOT NULL DEFAULT 'udp',   -- 'udp' | 'tcp'
  osc_enabled     INTEGER NOT NULL DEFAULT 0,       -- 0 = stub/log only, 1 = live send
  notes           TEXT    NOT NULL DEFAULT '',
  settings        TEXT    NOT NULL DEFAULT '{}',     -- JSON blob of Show Mode smart settings
  -- v2: Avantis (audio console) MIDI-over-TCP config (mirrors osc_* naming).
  avantis_ip      TEXT    NOT NULL DEFAULT '',
  avantis_port    INTEGER NOT NULL DEFAULT 51325,
  avantis_channel INTEGER NOT NULL DEFAULT 1,        -- base MIDI channel 1..16
  avantis_enabled INTEGER NOT NULL DEFAULT 0,        -- 0 = stub/log only, 1 = live send
  join_pin        TEXT    NOT NULL DEFAULT '',        -- '' = no PIN required to join
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- One row per distinct speaker; drives auto-coloring of dialogue.
CREATE TABLE IF NOT EXISTS characters (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  production_id INTEGER NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,
  color         TEXT    NOT NULL DEFAULT '#888888',
  UNIQUE(production_id, name)
);

-- The script as an ordered, typed list of lines.
-- A 'song' line is a container whose cues live in song_sections.
CREATE TABLE IF NOT EXISTS script_lines (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  production_id  INTEGER NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  type           TEXT    NOT NULL DEFAULT 'dialogue', -- act|scene|character|dialogue|stage_dir|song
  speaker        TEXT    NOT NULL DEFAULT '',
  text           TEXT    NOT NULL DEFAULT '',
  note           TEXT    NOT NULL DEFAULT '',          -- lights note (legacy column, v1 shows were lights-run)
  note_audio     TEXT    NOT NULL DEFAULT '',          -- audio operator's note (dept-scoped display)
  color_override TEXT                                  -- null => use speaker color
);

-- Ordered inner structure of a song (verse / chorus / bridge ...).
CREATE TABLE IF NOT EXISTS song_sections (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  song_line_id INTEGER NOT NULL REFERENCES script_lines(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  label        TEXT    NOT NULL DEFAULT '',
  note         TEXT    NOT NULL DEFAULT '',          -- lights note (legacy column)
  note_audio   TEXT    NOT NULL DEFAULT '',          -- audio operator's note (dept-scoped display)
  lyrics       TEXT    NOT NULL DEFAULT '',
  loop         INTEGER NOT NULL DEFAULT 0           -- 1 => LOOP section (A/B flare cycle in Show Mode)
);

-- A cue anchored either to a script line or to a song section.
CREATE TABLE IF NOT EXISTS cues (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  production_id INTEGER NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
  anchor_type   TEXT    NOT NULL DEFAULT 'line',  -- 'line' | 'section'
  anchor_id     INTEGER NOT NULL,
  cue_list      INTEGER NOT NULL DEFAULT 1,
  cue_number    TEXT    NOT NULL DEFAULT '',      -- text: Eos cues can be 1.5, 10.2, etc.
  label         TEXT    NOT NULL DEFAULT '',
  notes         TEXT    NOT NULL DEFAULT '',
  fire_mode     TEXT    NOT NULL DEFAULT 'fire',  -- 'fire' | 'go' | 'cmd'
  cmd_text      TEXT    NOT NULL DEFAULT '',
  -- v2: department model. Existing cues default to 'lights' (correct for the
  -- copied show); the fire path dispatches on department first.
  department    TEXT    NOT NULL DEFAULT 'lights', -- 'lights' | 'audio' | 'spot'
  spot_target   INTEGER NOT NULL DEFAULT 0,        -- 0 = all spots, 1..N = that spot
  avantis_scene INTEGER NOT NULL DEFAULT 0,        -- 1..500 when department='audio'
  spot_pickup   TEXT    NOT NULL DEFAULT '',
  spot_color    TEXT    NOT NULL DEFAULT '',
  spot_size     TEXT    NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_lines_prod    ON script_lines(production_id, seq);
CREATE INDEX IF NOT EXISTS idx_sections_song ON song_sections(song_line_id, seq);
CREATE INDEX IF NOT EXISTS idx_cues_prod     ON cues(production_id);
CREATE INDEX IF NOT EXISTS idx_cues_anchor   ON cues(anchor_type, anchor_id);

-- ===========================================================================
-- v2 multi-user tables (M1+). IF NOT EXISTS so they apply to the copied DB on
-- first boot without touching existing rows.
-- ===========================================================================

-- Crew identities. No accounts: a row is created at join and resumed via token.
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  production_id INTEGER NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'viewer',   -- 'caller'|'lights'|'audio'|'spot'|'viewer'
  spot_no       INTEGER NOT NULL DEFAULT 0,          -- 1..N when role='spot', else 0
  token         TEXT    NOT NULL UNIQUE,             -- crypto.randomUUID(); stored client-side
  is_admin      INTEGER NOT NULL DEFAULT 0,
  revoked       INTEGER NOT NULL DEFAULT 0,          -- 1 = kicked; token refused, row kept (notes survive)
  last_seen     TEXT    NOT NULL DEFAULT (datetime('now')),
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(production_id, name)
);

-- Private per-user notes, anchored exactly like cues.
CREATE TABLE IF NOT EXISTS user_notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  anchor_type TEXT    NOT NULL DEFAULT 'line',       -- 'line' | 'section'
  anchor_id   INTEGER NOT NULL,
  text        TEXT    NOT NULL DEFAULT '',
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, anchor_type, anchor_id)
);

-- Live show state snapshot so a server restart resumes the show (JSON of RoomState, §4.3).
CREATE TABLE IF NOT EXISTS show_state (
  production_id INTEGER PRIMARY KEY REFERENCES productions(id) ON DELETE CASCADE,
  state         TEXT NOT NULL DEFAULT '{}',
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_prod   ON users(production_id);
CREATE INDEX IF NOT EXISTS idx_notes_user   ON user_notes(user_id);
