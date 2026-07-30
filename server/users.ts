import { db } from "./db";
import type { Role, UserPublic } from "../shared/protocol";

// The full users row as stored in SQLite. is_admin / revoked are 0|1 ints.
export interface UserRow {
  id: number;
  production_id: number;
  name: string;
  role: Role;
  spot_no: number;
  token: string;
  is_admin: number;
  revoked: number;
  last_seen: string;
  created_at: string;
}

export function getUserByToken(token: string): UserRow | null {
  if (!token) return null;
  return (db.query("SELECT * FROM users WHERE token = ?").get(token) as UserRow | null) ?? null;
}

export function getUserById(id: number): UserRow | null {
  return (db.query("SELECT * FROM users WHERE id = ?").get(id) as UserRow | null) ?? null;
}

// Strip the private token / raw ints down to the wire shape non-privileged
// clients are allowed to see.
export function toPublic(u: UserRow): UserPublic {
  return {
    id: u.id,
    name: u.name,
    role: u.role,
    spot_no: u.spot_no,
    is_admin: !!u.is_admin,
  };
}
