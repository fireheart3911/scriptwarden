// server/routes/session.ts — identity, join, admin actions, net-info (§3).
//
// Lightweight, LAN-trusted auth: a crew member "joins" a production with a name
// + role (+ optional PIN) and receives a token they store client-side and
// present on the WebSocket and on token-guarded HTTP routes. No passwords.

import type { Context, Hono } from "hono";
import os from "node:os";
import { db } from "../db";
import { getUserById, getUserByToken, toPublic, type UserRow } from "../users";
import type { Role } from "../../shared/protocol";
import { hub } from "../ws/hub";
import { rooms } from "../ws/room";
import { syncEosMonitor } from "../eosSync";

const ROLES = new Set<Role>(["caller", "lights", "audio", "spot", "viewer", "regie"]);

function normalizeRole(v: unknown): Role {
  const s = String(v ?? "viewer");
  return (ROLES.has(s as Role) ? s : "viewer") as Role;
}

// X-Token -> the admin user row, or null if the token is missing / invalid /
// revoked / not an admin.
export function adminFromToken(c: Context): UserRow | null {
  const u = getUserByToken(c.req.header("X-Token") ?? "");
  if (!u || u.revoked || !u.is_admin) return null;
  return u;
}

export function registerSession(app: Hono): void {
  // --- join -----------------------------------------------------------------
  app.post("/api/productions/:id/join", async (c) => {
    const productionId = Number(c.req.param("id"));
    const production = db
      .query("SELECT id, join_pin FROM productions WHERE id = ?")
      .get(productionId) as { id: number; join_pin: string } | null;
    if (!production) return c.json({ error: "not_found" }, 404);

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const name = String(body.name ?? "").trim();
    if (!name) return c.json({ error: "name_required" }, 400);
    const role = normalizeRole(body.role);
    const spotNo = Math.max(0, Math.trunc(Number(body.spot_no) || 0));
    const pin = String(body.pin ?? "");

    const adminPin = process.env.SCRIPTWARDEN_ADMIN_PIN;
    const isAdminByPin = !!adminPin && pin === adminPin;

    // First connection is the admin: when no active (non-revoked) crew exists
    // yet in this production, the joining user becomes admin. Later joins are
    // regular crew — admin can then set the session PIN, manage the Ion/Avantis
    // settings and kick devices. The env admin PIN stays as an escape hatch.
    const noActiveCrew =
      (db
        .query("SELECT COUNT(*) AS n FROM users WHERE production_id = ? AND revoked = 0")
        .get(productionId) as { n: number }).n === 0;

    // PIN gate. Empty join_pin = open. The admin PIN is an escape hatch that
    // bypasses the join PIN (so the host can always get in).
    if (production.join_pin !== "" && pin !== production.join_pin && !isAdminByPin) {
      return c.json({ error: "bad_pin" }, 403);
    }

    // Name reclaim (case-insensitive). A revoked (kicked) row with the same
    // name is also reclaimed — its old token stays dead and the PIN gate above
    // already passed — which avoids tripping the UNIQUE(production_id, name)
    // constraint on re-insert.
    const existing = db
      .query("SELECT * FROM users WHERE production_id = ? AND lower(name) = lower(?)")
      .get(productionId, name) as UserRow | null;

    const token = crypto.randomUUID();
    let userRow: UserRow;
    if (existing) {
      // Reissue token + update role/spot_no, then force-close the old device
      // ("signed in elsewhere"). Its previous token is now stale. Admin is
      // KEPT if the row already had it (reclaiming never demotes), and granted
      // via the escape-hatch PIN — but a plain rejoin never grants it.
      const keepAdmin = (!existing.revoked && !!existing.is_admin) || isAdminByPin;
      db.query(
        `UPDATE users SET token = ?, role = ?, spot_no = ?, is_admin = ?, revoked = 0, last_seen = datetime('now')
         WHERE id = ?`,
      ).run(token, role, spotNo, keepAdmin ? 1 : 0, existing.id);
      hub.closeUser(existing.id, { reason: "signed in elsewhere" });
      userRow = getUserById(existing.id)!;
    } else {
      const isAdmin = noActiveCrew || isAdminByPin;
      userRow = db
        .query(
          `INSERT INTO users (production_id, name, role, spot_no, token, is_admin)
           VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
        )
        .get(productionId, name, role, spotNo, token, isAdmin ? 1 : 0) as UserRow;
    }

    // A joining caller claims the caller flag if it is currently vacant.
    if (role === "caller") rooms.get(productionId).claimCallerIfVacant(userRow.id);

    // Someone is watching now — make sure the console monitor is running.
    syncEosMonitor(productionId);

    return c.json({ token, user: toPublic(userRow) });
  });

  // --- net info (QR / manual join URL) --------------------------------------
  app.get("/api/net-info", (c) => {
    const ips: string[] = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list ?? []) {
        // Node/Bun report family as "IPv4" (string) or 4 (number) across versions.
        const isV4 = ni.family === "IPv4" || (ni.family as unknown as number) === 4;
        if (isV4 && !ni.internal) ips.push(ni.address);
      }
    }
    const port = Number(process.env.PORT ?? 3002);
    return c.json({ port, ips, urls: ips.map((ip) => `http://${ip}:${port}`) });
  });

  // --- roster (token-authed) ------------------------------------------------
  app.get("/api/productions/:id/roster", (c) => {
    const productionId = Number(c.req.param("id"));
    const u = getUserByToken(c.req.header("X-Token") ?? "");
    if (!u || u.revoked || u.production_id !== productionId) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return c.json({ roster: hub.roster(productionId) });
  });

  // --- admin: kick ----------------------------------------------------------
  app.post("/api/admin/kick", async (c) => {
    const admin = adminFromToken(c);
    if (!admin) return c.json({ error: "forbidden" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const userId = Number(body.userId);
    const target = getUserById(userId);
    if (!target || target.production_id !== admin.production_id) {
      return c.json({ error: "not_found" }, 404);
    }
    db.query("UPDATE users SET revoked = 1 WHERE id = ?").run(userId);
    // Release the caller flag if the kicked user held it.
    const room = rooms.get(admin.production_id);
    if (room.state.callerUserId === userId) room.setCaller(null);
    hub.closeUser(userId, { sendKicked: true, code: 4001, reason: "kicked" });
    hub.broadcastRoster(admin.production_id);
    return c.json({ ok: true });
  });

  // --- admin: grant / transfer caller ---------------------------------------
  app.post("/api/admin/caller", async (c) => {
    const admin = adminFromToken(c);
    if (!admin) return c.json({ error: "forbidden" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const userId = Number(body.userId);
    const target = getUserById(userId);
    if (!target || target.production_id !== admin.production_id || target.revoked) {
      return c.json({ error: "not_found" }, 404);
    }
    rooms.get(admin.production_id).setCaller(userId);
    return c.json({ ok: true, callerUserId: userId });
  });
}
