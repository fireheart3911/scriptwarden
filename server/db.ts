import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dbPath = process.env.SCRIPTWARDEN_DB ?? "scriptwarden.db";

export const db = new Database(dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

// Apply schema (all statements are IF NOT EXISTS, so this is idempotent).
const schema = readFileSync(join(import.meta.dir, "..", "schema.sql"), "utf8");
db.exec(schema);

// Additive migrations. schema.sql only runs CREATE TABLE IF NOT EXISTS, so an
// existing database keeps its original columns — new columns must be added by
// hand here. Each migration inspects the current shape and is a no-op when the
// column already exists, so this is safe to run on every boot.
function ensureColumn(table: string, column: string, ddl: string): void {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

// song_sections.lyrics: paste-in song lyrics, shown in Show Mode.
ensureColumn("song_sections", "lyrics", "lyrics TEXT NOT NULL DEFAULT ''");
// song_sections.loop: 1 => LOOP section, GO cycles its cues (A/B flares) in Show Mode.
ensureColumn("song_sections", "loop", "loop INTEGER NOT NULL DEFAULT 0");
// productions.settings: JSON blob of per-production Show Mode smart settings.
ensureColumn("productions", "settings", "settings TEXT NOT NULL DEFAULT '{}'");

// v2 additive columns (inert without UI until M1+). schema.sql carries these
// inline for fresh DBs; these ensureColumn calls add them to the copied v1 show.
// cues: department model (existing cues default to 'lights' — correct for the copied show)
ensureColumn("cues", "department",    "department TEXT NOT NULL DEFAULT 'lights'"); // 'lights'|'audio'|'spot'
ensureColumn("cues", "spot_target",   "spot_target INTEGER NOT NULL DEFAULT 0");    // 0 = all spots, 1..N = that spot
ensureColumn("cues", "avantis_scene", "avantis_scene INTEGER NOT NULL DEFAULT 0");  // 1..500 when department='audio'
ensureColumn("cues", "spot_pickup",   "spot_pickup TEXT NOT NULL DEFAULT ''");
ensureColumn("cues", "spot_color",    "spot_color TEXT NOT NULL DEFAULT ''");
ensureColumn("cues", "spot_size",     "spot_size TEXT NOT NULL DEFAULT ''");

// productions: Avantis config (mirrors osc_* naming) + join PIN
ensureColumn("productions", "avantis_ip",      "avantis_ip TEXT NOT NULL DEFAULT ''");
ensureColumn("productions", "avantis_port",    "avantis_port INTEGER NOT NULL DEFAULT 51325");
ensureColumn("productions", "avantis_channel", "avantis_channel INTEGER NOT NULL DEFAULT 1"); // base MIDI channel 1..16
ensureColumn("productions", "avantis_enabled", "avantis_enabled INTEGER NOT NULL DEFAULT 0");
ensureColumn("productions", "join_pin",        "join_pin TEXT NOT NULL DEFAULT ''");          // '' = no PIN

// Department-scoped notes: the legacy `note` column is the LIGHTS note (the v1
// show was lights-run); `note_audio` is the audio operator's note. Each
// operator role sees only its own department's notes in Show Mode.
ensureColumn("script_lines",  "note_audio", "note_audio TEXT NOT NULL DEFAULT ''");
ensureColumn("song_sections", "note_audio", "note_audio TEXT NOT NULL DEFAULT ''");

// One-time data migrations, tracked via PRAGMA user_version.
//
// v1: normalize admins. The old join rule granted is_admin to every loopback
// request — behind the Vite dev proxy that was EVERY device, so existing DBs
// have all-admin crews. The new rule is "the first connection is the admin":
// keep admin only on each production's earliest-created active user, demote
// the rest. (SCRIPTWARDEN_ADMIN_PIN can re-grant admin at join if needed.)
const userVersion = (db.query("PRAGMA user_version").get() as { user_version: number })
  .user_version;
if (userVersion < 1) {
  db.transaction(() => {
    db.exec(`
      UPDATE users SET is_admin = CASE WHEN id IN (
        SELECT id FROM users u WHERE revoked = 0 AND NOT EXISTS (
          SELECT 1 FROM users e
          WHERE e.production_id = u.production_id AND e.revoked = 0
            AND (e.created_at < u.created_at OR (e.created_at = u.created_at AND e.id < u.id))
        )
      ) THEN 1 ELSE 0 END;
    `);
    db.exec("PRAGMA user_version = 1;");
  })();
  console.log("[db] migration v1: normalized admins (first active user per production)");
}

// --- show_state (live RoomState snapshot) read/write --------------------------
// The room layer (server/ws/room.ts) owns the JSON shape; db.ts just persists
// the blob so a server restart can resume the show (§4.3).
export function readShowState(productionId: number): string | null {
  const row = db
    .query("SELECT state FROM show_state WHERE production_id = ?")
    .get(productionId) as { state: string } | null;
  return row?.state ?? null;
}

export function writeShowState(productionId: number, state: string): void {
  db.query(
    `INSERT INTO show_state (production_id, state, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(production_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
  ).run(productionId, state);
}

// --- shutdown hooks -----------------------------------------------------------
// Other modules (e.g. the room layer) register a synchronous flush to run in the
// SIGINT/SIGTERM handler alongside the WAL checkpoint, without db.ts having to
// import them (keeps db.ts foundational / dependency-free).
const shutdownHooks: (() => void)[] = [];
export function onShutdown(fn: () => void): void {
  shutdownHooks.push(fn);
}
function runShutdownHooks(): void {
  for (const fn of shutdownHooks) {
    try {
      fn();
    } catch (e) {
      console.error("[db] shutdown hook failed", e);
    }
  }
}

// Keep the main .db file fresh. With WAL, recent writes live in the -wal
// sidecar until a checkpoint; file-level sync tools (Syncthing) treat the
// three files independently, so a stale main file + fresh WAL can be torn
// apart into a corrupt/mismatched pair on another machine. Checkpointing
// often keeps everything in scriptwarden.db, making the sidecars disposable
// (and safe to .stignore).
function checkpoint(): void {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } catch {
    /* busy is fine — next tick catches up */
  }
}
const timer = setInterval(checkpoint, 60_000);
if (typeof timer.unref === "function") timer.unref();
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    // Flush live show state to show_state first, THEN checkpoint so the writes
    // land in the main .db file rather than being stranded in the WAL sidecar.
    runShutdownHooks();
    checkpoint();
    process.exit(0);
  });
}
