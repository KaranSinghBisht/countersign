/**
 * A worker that dies mid-tick leaves its message in_flight. That is every
 * PaaS deploy, so the reclaim path is the difference between a delayed order
 * and a buyer holding a 200 for an order that is never created.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Sql } from "../../src/db/client.js";
import { claim, enqueue, purgeDone } from "../../src/razorpay/outbox.js";
import { migrateOnce, testDb, truncateAll } from "./helpers.js";

let sql: Sql;

beforeAll(async () => {
  sql = testDb();
  await migrateOnce(sql);
});

afterAll(async () => {
  await sql.end();
});

beforeEach(async () => {
  await truncateAll(sql);
});

describe("outbox reclaim", () => {
  it("reclaims an in_flight message once its lease has lapsed", async () => {
    await enqueue(sql, {
      id: "ob-strand-1",
      kind: "create_order",
      stream: "auth:strand",
      payload: { receipt: "prSTRAND" },
    });

    const first = await claim(sql, 1);
    expect(first?.id).toBe("ob-strand-1");
    expect(first?.attempts).toBe(1);

    // The worker dies here: no complete, no retry, no in_doubt. Only the
    // lease can bring the message back.
    await sql`UPDATE outbox SET lease_expires_at = now() - interval '1 second' WHERE id = 'ob-strand-1'`;

    const again = await claim(sql, 1);
    expect(again?.id).toBe("ob-strand-1");
    expect(again?.attempts).toBe(2);
  });

  it("leaves an in_flight message alone while its lease is live", async () => {
    await enqueue(sql, {
      id: "ob-live-1",
      kind: "create_order",
      stream: "auth:live",
      payload: { receipt: "prLIVE" },
    });

    expect((await claim(sql, 60))?.id).toBe("ob-live-1");
    expect(await claim(sql, 60)).toBeUndefined();
  });
});

describe("outbox retention", () => {
  it("purges done messages past the retention window and nothing else", async () => {
    await enqueue(sql, { id: "old-done", kind: "create_order", stream: "r1", payload: {} });
    await enqueue(sql, { id: "new-done", kind: "create_order", stream: "r2", payload: {} });
    await enqueue(sql, { id: "old-failed", kind: "create_order", stream: "r3", payload: {} });
    await sql`UPDATE outbox SET state = 'done', updated_at = now() - interval '8 days' WHERE id = 'old-done'`;
    await sql`UPDATE outbox SET state = 'done' WHERE id = 'new-done'`;
    await sql`UPDATE outbox SET state = 'failed', updated_at = now() - interval '8 days' WHERE id = 'old-failed'`;

    expect(await purgeDone(sql)).toBe(1);

    const left = await sql<{ id: string }[]>`SELECT id FROM outbox ORDER BY id`;
    // A failed message is evidence of a stuck order; retention never eats it.
    expect(left.map((r) => r.id)).toEqual(["new-done", "old-failed"]);
  });
});
