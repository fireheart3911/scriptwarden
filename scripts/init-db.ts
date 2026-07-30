// init-db.ts — snapshot the real v1 show DB into v2 for standalone v2 development.
//
// Opens ../scriptwarden.db STRICTLY READ-ONLY and runs `VACUUM INTO` to produce
// an atomic, self-contained snapshot at ./scriptwarden.db (paths relative to the
// v2 cwd, i.e. run via `bun run setup` from the v2 root). VACUUM INTO reads the
// source inside a single transaction and never writes it, so it is safe to run
// even while the v1 server is live on 3001 (v1's 60s checkpoint keeps the main
// file fresh). The resulting file has no WAL sidecar — it is a clean copy.
//
// Refuses to overwrite an existing v2 snapshot so a working v2 DB (which may hold
// v2-only edits) is never clobbered.
import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const cwd = process.cwd();
const srcPath = resolve(cwd, "..", "scriptwarden.db"); // the real v1 show DB (read-only)
const destPath = resolve(cwd, "scriptwarden.db"); // v2's own private copy

// 1. Never clobber an existing v2 database.
if (existsSync(destPath)) {
  console.error(
    `\n[setup] Refusing to overwrite an existing v2 snapshot:\n  ${destPath}\n\n` +
      `This is v2's own database and may already hold v2-only edits.\n` +
      `To rebuild it fresh from the current v1 show, delete it (and any WAL\n` +
      `sidecars) by hand first, then re-run setup:\n\n` +
      `  rm -f "${destPath}" "${destPath}-wal" "${destPath}-shm"\n` +
      `  bun run setup\n`,
  );
  process.exit(0); // not an error — the safe, expected refusal path
}

// 2. The source must exist (v2/ is expected to sit beside the v1 scriptwarden.db).
if (!existsSync(srcPath)) {
  console.error(
    `\n[setup] Cannot find the v1 database to snapshot:\n  ${srcPath}\n\n` +
      `Expected v2/ to sit directly beside the v1 scriptwarden.db.\n` +
      `Nothing was written.\n`,
  );
  process.exit(1);
}

// 3. Read-only snapshot via VACUUM INTO. The readonly flag guarantees the source
//    show DB is never mutated; VACUUM INTO writes a fresh, consistent copy.
console.log(`[setup] Snapshotting  ${srcPath}\n              ->    ${destPath}`);
const src = new Database(srcPath, { readonly: true });
try {
  // Inline the destination as an escaped SQL string literal (single quotes
  // doubled). VACUUM INTO cannot be a prepared/parameterized statement.
  const escaped = destPath.replace(/'/g, "''");
  src.exec(`VACUUM INTO '${escaped}'`);
} finally {
  src.close();
}

// 4. Report row counts by reading the NEW file — proves the snapshot is a valid,
//    queryable database.
const snap = new Database(destPath, { readonly: true });
const count = (table: string): number =>
  (snap.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const productions = count("productions");
const scriptLines = count("script_lines");
const cues = count("cues");
snap.close();

const size = statSync(destPath).size;
console.log(
  `[setup] Snapshot created (${size.toLocaleString()} bytes):\n` +
    `          productions:  ${productions}\n` +
    `          script_lines: ${scriptLines}\n` +
    `          cues:         ${cues}\n` +
    `[setup] Done. Run \`bun run build && bun start\` to serve v2 on :3002.`,
);
