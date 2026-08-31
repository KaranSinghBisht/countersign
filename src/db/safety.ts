/**
 * The one guard between a destructive reset and the audit log.
 *
 * Both the integration suite and `make demo` truncate every table in whatever
 * database DATABASE_URL names, with the append-only triggers suspended. One
 * stray production URL in the environment — the natural thing to paste into
 * .env after a deploy, to run `make export` — and the audit log, which is the
 * product, is gone. So anything that truncates refuses a non-local database
 * unless the operator says otherwise explicitly.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function assertSafeToTruncate(url: string, what: string): void {
  if (process.env.COUNTERSIGN_TEST_DB_UNSAFE_OK === "1") return;
  if (process.env.NODE_ENV === "production") {
    throw new Error(`refusing to run ${what} with NODE_ENV=production`);
  }
  const host = new URL(url).hostname;
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `refusing to truncate a non-local database (${host}); ${what} destroys the audit log. ` +
        "Point DATABASE_URL at a local database, or set COUNTERSIGN_TEST_DB_UNSAFE_OK=1 " +
        "if you really mean it.",
    );
  }
}
