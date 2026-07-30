// server/ws/hub.ts — socket registry, auth, heartbeat, presence, broadcast (§4.1/§4.4).
//
// The hub owns the WebSocket transport: it authenticates each connection from
// the token in ws.data, subscribes it to its production's topic, tracks who is
// online for the roster, runs the server heartbeat + silence sweep, and exposes
// broadcast helpers that both the room layer and the HTTP routes use. Exported
// as a singleton `hub`; index.ts calls `hub.bind(server)` after Bun.serve so the
// hub can publish through the server.

import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { db } from "../db";
import { getUserById, getUserByToken, toPublic, type UserRow } from "../users";
import type { C2S, RosterEntry, S2C } from "../../shared/protocol";
import { rooms } from "./room";

export interface WsData {
  token: string;
  userId?: number;
  productionId?: number;
  lastMsg?: number; // ms epoch of last inbound frame (for the silence sweep)
  lastDbWrite?: number; // ms epoch of last last_seen DB write (throttle)
}

const HB_MS = 5_000; // server heartbeat cadence
const SWEEP_MS = 5_000; // presence sweep cadence
const SILENCE_MS = 25_000; // no inbound frame for this long => reap the socket
const SEEN_THROTTLE_MS = 5_000; // min gap between users.last_seen writes per socket

class Hub {
  private server: Server<WsData> | null = null;
  private started = false;

  // userId -> live sockets (usually one; a reclaim closes the old before adding).
  private byUser = new Map<number, Set<ServerWebSocket<WsData>>>();
  // productionId -> socket count, for heartbeat fan-out over active rooms only.
  private prodCount = new Map<number, number>();

  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  // Bun WebSocket handler object. Arrow fields capture `this` (Bun invokes these
  // as bare functions, so method `this` would otherwise be undefined).
  readonly handlers: WebSocketHandler<WsData> = {
    open: (ws) => this.onOpen(ws),
    message: (ws, msg) => this.onMessage(ws, msg),
    close: (ws) => this.onClose(ws),
  };

  bind(server: Server<WsData>): void {
    this.server = server;
    if (!this.started) {
      this.started = true;
      this.hbTimer = setInterval(() => this.tickHeartbeat(), HB_MS);
      this.sweepTimer = setInterval(() => this.sweep(), SWEEP_MS);
      if (typeof this.hbTimer.unref === "function") this.hbTimer.unref();
      if (typeof this.sweepTimer.unref === "function") this.sweepTimer.unref();
    }
  }

  getServer(): Server<WsData> | null {
    return this.server;
  }

  // --- broadcast helpers ----------------------------------------------------

  broadcast(productionId: number, msg: S2C): void {
    this.server?.publish(`room:${productionId}`, JSON.stringify(msg));
  }

  broadcastRoster(productionId: number): void {
    this.broadcast(productionId, { type: "roster", roster: this.roster(productionId) });
  }

  roster(productionId: number): RosterEntry[] {
    const users = db
      .query("SELECT * FROM users WHERE production_id = ? AND revoked = 0 ORDER BY id")
      .all(productionId) as UserRow[];
    const callerId = rooms.get(productionId).state.callerUserId;
    return users.map((u) => ({
      user: toPublic(u),
      online: (this.byUser.get(u.id)?.size ?? 0) > 0,
      isCaller: callerId === u.id,
    }));
  }

  isOnline(userId: number): boolean {
    return (this.byUser.get(userId)?.size ?? 0) > 0;
  }

  // Force-close every live socket for a user (reclaim / kick). For a kick, send
  // the `kicked` frame first so the client wipes its token and returns to Join.
  closeUser(
    userId: number,
    opts: { sendKicked?: boolean; code?: number; reason?: string } = {},
  ): void {
    const set = this.byUser.get(userId);
    if (!set) return;
    for (const ws of [...set]) {
      if (opts.sendKicked) {
        try {
          ws.send(JSON.stringify({ type: "kicked" } satisfies S2C));
        } catch {
          /* socket already gone */
        }
      }
      try {
        ws.close(opts.code ?? 4001, opts.reason ?? "closed");
      } catch {
        /* already closed */
      }
    }
  }

  // --- socket lifecycle -----------------------------------------------------

  private onOpen(ws: ServerWebSocket<WsData>): void {
    const user = getUserByToken(ws.data.token);
    if (!user || user.revoked) {
      ws.close(4001, "bad or revoked token");
      return;
    }
    ws.data.userId = user.id;
    ws.data.productionId = user.production_id;
    ws.data.lastMsg = Date.now();

    this.addSocket(user.id, user.production_id, ws);
    ws.subscribe(`room:${user.production_id}`);
    this.markSeen(user.id, ws, true);

    const room = rooms.get(user.production_id);
    const welcome: S2C = {
      type: "welcome",
      you: toPublic(user),
      state: room.snapshot(),
      roster: this.roster(user.production_id),
    };
    ws.send(JSON.stringify(welcome));

    // Let everyone else see the new/returning presence.
    this.broadcastRoster(user.production_id);
  }

  private onMessage(ws: ServerWebSocket<WsData>, raw: string | Buffer): void {
    ws.data.lastMsg = Date.now();
    if (ws.data.userId == null || ws.data.productionId == null) {
      ws.close(4001, "not authenticated");
      return;
    }
    // Re-check the row each frame so a mid-session kick (revoked=1) is enforced
    // even if the close race hasn't fired yet.
    const user = getUserById(ws.data.userId);
    if (!user || user.revoked) {
      ws.close(4001, "revoked");
      return;
    }
    this.markSeen(user.id, ws, false);

    let msg: C2S;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8")) as C2S;
    } catch {
      return;
    }

    const room = rooms.get(ws.data.productionId);
    switch (msg.type) {
      case "hb":
        return; // presence-only; markSeen already handled it
      case "position":
        room.handlePosition(user, String(msg.key ?? ""), Number(msg.idx ?? 0), ws, !!msg.adminOverride);
        return;
      case "showStart":
        room.handleShowStart(user, ws);
        return;
      case "showStop":
        room.handleShowStop(user, ws);
        return;
      case "timerClear":
        room.handleTimerClear(user, ws);
        return;
      case "showPause":
        room.handleShowPause(user, msg.resumeInSec, ws);
        return;
      case "showResume":
        room.handleShowResume(user, ws);
        return;
      case "showCountdown":
        room.handleShowCountdown(user, msg.inSec, ws);
        return;
      case "readyCheck":
        room.handleReadyCheck(user, msg.action === "stop" ? "stop" : "start", ws);
        return;
      case "ready":
        room.handleReady(user);
        return;
      case "codeRaise":
        room.handleCodeRaise(user, msg.level, msg.msg, msg.targetUserId, ws);
        return;
      case "codeClear":
        room.handleCodeClear(user, ws);
        return;
      case "reset":
        room.handleReset(user, ws);
        return;
      case "grantCaller":
        room.handleGrantCaller(user, Number(msg.userId), ws);
        return;
      case "sync":
        room.handleSync(ws);
        return;
      // M2 department firing (server-authoritative, §4.3).
      case "go":
        room.handleGo(
          user,
          msg.dept,
          String(msg.expectedKey ?? ""),
          !!msg.force,
          ws,
          msg.anchorKey ? String(msg.anchorKey) : undefined,
        );
        return;
      case "exitLoop":
        room.handleExitLoop(
          user,
          msg.dept,
          String(msg.expectedKey ?? ""),
          ws,
          msg.anchorKey ? String(msg.anchorKey) : undefined,
        );
        return;
      case "rearm":
        room.handleRearm(user, msg.dept, String(msg.fromKey ?? ""), ws);
        return;
      default:
        return;
    }
  }

  private onClose(ws: ServerWebSocket<WsData>): void {
    if (ws.data.userId != null && ws.data.productionId != null) {
      this.removeSocket(ws.data.userId, ws.data.productionId, ws);
      this.broadcastRoster(ws.data.productionId);
    }
  }

  // --- registry bookkeeping -------------------------------------------------

  private addSocket(userId: number, productionId: number, ws: ServerWebSocket<WsData>): void {
    let set = this.byUser.get(userId);
    if (!set) {
      set = new Set();
      this.byUser.set(userId, set);
    }
    set.add(ws);
    this.prodCount.set(productionId, (this.prodCount.get(productionId) ?? 0) + 1);
  }

  private removeSocket(userId: number, productionId: number, ws: ServerWebSocket<WsData>): void {
    const set = this.byUser.get(userId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) this.byUser.delete(userId);
    }
    const n = (this.prodCount.get(productionId) ?? 1) - 1;
    if (n <= 0) this.prodCount.delete(productionId);
    else this.prodCount.set(productionId, n);
  }

  // --- presence -------------------------------------------------------------

  private markSeen(userId: number, ws: ServerWebSocket<WsData>, force: boolean): void {
    const now = Date.now();
    if (!force && ws.data.lastDbWrite && now - ws.data.lastDbWrite < SEEN_THROTTLE_MS) return;
    ws.data.lastDbWrite = now;
    try {
      db.query("UPDATE users SET last_seen = datetime('now') WHERE id = ?").run(userId);
    } catch {
      /* best-effort presence */
    }
  }

  private tickHeartbeat(): void {
    const t = Date.now();
    const frame = JSON.stringify({ type: "hb", t } satisfies S2C);
    for (const productionId of this.prodCount.keys()) {
      this.server?.publish(`room:${productionId}`, frame);
    }
  }

  // Reap sockets that have gone silent past SILENCE_MS (dead booth wifi): close
  // them, which fires onClose -> roster update. The client watchdog reconnects.
  private sweep(): void {
    const now = Date.now();
    for (const set of this.byUser.values()) {
      for (const ws of [...set]) {
        if (now - (ws.data.lastMsg ?? now) > SILENCE_MS) {
          try {
            ws.close(4002, "silent");
          } catch {
            /* already closed */
          }
        }
      }
    }
  }
}

export const hub = new Hub();
