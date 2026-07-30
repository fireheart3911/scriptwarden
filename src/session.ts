// src/session.ts — crew identity persisted in localStorage (§3, §4.1).
//
// A crew member "joins" a production once and stores the returned token + who
// they are. The token is presented on the WebSocket (?token=…) and as an
// X-Token header on the guarded HTTP routes. No passwords; the token IS the
// identity. Cleared on kick / "signed in elsewhere" / manual sign-out.

import type { Role } from "../shared/protocol";

export interface Identity {
  token: string;
  name: string;
  role: Role;
  spotNo: number;
  productionId: number;
  userId: number;
  isAdmin: boolean;
}

const KEY = "scriptwarden.identity";

// Read the stored identity, or null if none / malformed. Defensive parse so a
// corrupt localStorage value falls back to the Join screen instead of crashing.
export function getSession(): Identity | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Identity>;
    if (!v || typeof v.token !== "string" || typeof v.productionId !== "number") return null;
    return {
      token: v.token,
      name: String(v.name ?? ""),
      role: (v.role ?? "viewer") as Role,
      spotNo: Number(v.spotNo ?? 0),
      productionId: v.productionId,
      userId: Number(v.userId ?? 0),
      isAdmin: !!v.isAdmin,
    };
  } catch {
    return null;
  }
}

export function setSession(id: Identity): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(id));
  } catch {
    /* private mode / quota — identity just won't persist across reloads */
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
