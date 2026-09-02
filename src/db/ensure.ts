/**
 * Create the database a local URL names, if it does not exist yet.
 *
 * `make demo` and the integration suite each get their own database so that
 * neither can truncate the one `make dev` writes the real audit log to. A
 * fresh clone has no such databases; rather than a README step, they are
 * created on first use through the maintenance database.
 *
 * Returns true when the database was created. Postgres being unreachable is
 * not an error here — the caller has its own probe and its own message.
 */

import { connect } from "./client.js";

export async function ensureDatabase(url: string): Promise<boolean> {
  const target = new URL(url);
  const name = target.pathname.slice(1);
  const maintenance = new URL(url);
  maintenance.pathname = "/postgres";
  const sql = connect({ url: maintenance.toString(), max: 1, connectTimeoutSeconds: 3 });
  try {
    const found = await sql`SELECT 1 FROM pg_database WHERE datname = ${name}`;
    if (found.length > 0) return false;
    await sql.unsafe(`CREATE DATABASE "${name.replaceAll('"', '""')}"`);
    return true;
  } catch {
    return false;
  } finally {
    await sql.end();
  }
}
