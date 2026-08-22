import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Sql } from "../../src/db/client.js";
import { isCheckViolation, isForeignKeyViolation } from "../../src/db/client.js";
import {
  balanceOf,
  balances,
  capturePostings,
  ensureAccounts,
  holdPostings,
  isInBalance,
  LedgerError,
  post,
  releasePostings,
} from "../../src/ledger/ledger.js";
import { money, zero } from "../../src/money/money.js";
import { migrateOnce, testDb, testId, truncateAll } from "./helpers.js";

let sql: Sql;

const INR = "INR" as const;
const amount = (minor: bigint) => money(minor, INR);

beforeAll(async () => {
  sql = testDb();
  await migrateOnce(sql);
});

afterAll(async () => {
  await sql.end();
});

beforeEach(async () => {
  await truncateAll(sql);
  await ensureAccounts(sql, INR);
});

describe("posting", () => {
  it("posts a balanced transaction and derives the balances", async () => {
    await post(sql, {
      id: testId(),
      kind: "hold",
      memo: "authorization hold",
      postings: holdPostings(amount(1_499_000n)),
    });

    expect(await balanceOf(sql, "asset:authorization_holds", INR)).toEqual(amount(1_499_000n));
    expect(await balanceOf(sql, "asset:buyer_receivable", INR)).toEqual(amount(-1_499_000n));
  });

  it("refuses an unbalanced transaction before it reaches the database", async () => {
    await expect(
      post(sql, {
        id: testId(),
        kind: "hold",
        memo: "unbalanced",
        postings: [
          { account: "asset:authorization_holds", amount: amount(100n) },
          { account: "asset:buyer_receivable", amount: amount(-99n) },
        ],
      }),
    ).rejects.toThrow(LedgerError);

    expect((await isInBalance(sql)).ok).toBe(true);
  });

  it("refuses a single-legged transaction", async () => {
    await expect(
      post(sql, {
        id: testId(),
        kind: "hold",
        memo: "one leg",
        postings: [{ account: "asset:authorization_holds", amount: amount(100n) }],
      }),
    ).rejects.toThrow(/double-entry requires at least two/);
  });

  it("refuses an entry naming an account that does not exist", async () => {
    const error = await post(sql, {
      id: testId(),
      kind: "hold",
      memo: "typo in account name",
      postings: [
        { account: "asset:authorizaton_holds", amount: amount(100n) },
        { account: "asset:buyer_receivable", amount: amount(-100n) },
      ],
    }).catch((e: unknown) => e);

    // A misspelled account must not silently create a new one, or money
    // balances into a place nobody reconciles.
    expect(isForeignKeyViolation(error)).toBe(true);
  });

  it("refuses an entry in a currency its account does not hold", async () => {
    const error = await post(sql, {
      id: testId(),
      kind: "hold",
      memo: "currency the account does not hold",
      postings: [
        { account: "asset:authorization_holds", amount: money(100n, "USD") },
        { account: "asset:buyer_receivable", amount: money(-100n, "USD") },
      ],
    }).catch((e: unknown) => e);

    expect(isForeignKeyViolation(error)).toBe(true);
  });
});

describe("the deferred balance constraint", () => {
  it("rejects an unbalanced transaction written directly, bypassing post()", async () => {
    // The application check is a better error message. THIS is the
    // guarantee — it holds for a psql session too.
    const id = testId();

    const error = await sql
      .begin(async (tx) => {
        await tx`
					INSERT INTO ledger_transactions (id, kind, memo)
					VALUES (${id}, 'hold', 'written by hand')
				`;
        await tx`
					INSERT INTO ledger_entries (transaction_id, account_id, currency, amount_minor)
					VALUES (${id}, 'asset:authorization_holds', 'INR', 100)
				`;
      })
      .catch((e: unknown) => e);

    expect(isCheckViolation(error)).toBe(true);
    expect(String(error)).toMatch(/does not balance/);
  });

  it("allows the intermediate imbalance every transfer passes through", async () => {
    // The reason the constraint is DEFERRED. After the first leg the
    // transaction is unbalanced by definition; an immediate check would
    // reject every legitimate posting.
    const id = testId();

    await sql.begin(async (tx) => {
      await tx`
				INSERT INTO ledger_transactions (id, kind, memo)
				VALUES (${id}, 'hold', 'two legs, checked at commit')
			`;
      await tx`
				INSERT INTO ledger_entries (transaction_id, account_id, currency, amount_minor)
				VALUES (${id}, 'asset:authorization_holds', 'INR', 100)
			`;
      await tx`
				INSERT INTO ledger_entries (transaction_id, account_id, currency, amount_minor)
				VALUES (${id}, 'asset:buyer_receivable', 'INR', -100)
			`;
    });

    expect(await balanceOf(sql, "asset:authorization_holds", INR)).toEqual(amount(100n));
  });

  it("rejects a zero-value entry", async () => {
    const id = testId();
    const error = await sql
      .begin(async (tx) => {
        await tx`
					INSERT INTO ledger_transactions (id, kind, memo) VALUES (${id}, 'hold', 'zero')
				`;
        await tx`
					INSERT INTO ledger_entries (transaction_id, account_id, currency, amount_minor)
					VALUES (${id}, 'asset:authorization_holds', 'INR', 0)
				`;
      })
      .catch((e: unknown) => e);

    expect(isCheckViolation(error)).toBe(true);
  });
});

describe("immutability", () => {
  const postOne = async () => {
    const id = testId();
    await post(sql, { id, kind: "hold", memo: "hold", postings: holdPostings(amount(500n)) });
    return id;
  };

  it("refuses UPDATE, even for the table owner", async () => {
    // REVOKE does not bind the owner, and migrations run as the owner. The
    // trigger is what makes append-only true rather than aspirational.
    await postOne();

    await expect(sql`UPDATE ledger_entries SET amount_minor = 1`).rejects.toThrow(/append-only/);
  });

  it("refuses DELETE", async () => {
    await postOne();
    await expect(sql`DELETE FROM ledger_entries`).rejects.toThrow(/append-only/);
  });

  it("refuses TRUNCATE", async () => {
    await postOne();
    await expect(sql`TRUNCATE ledger_entries`).rejects.toThrow(/append-only/);
  });

  it("directs the reader to the correction that IS allowed", async () => {
    await postOne();
    await expect(sql`DELETE FROM ledger_entries`).rejects.toThrow(/reversing entry/);
  });

  it("corrects a mistake by reversal, leaving both entries visible", async () => {
    const id = testId();
    await post(sql, {
      id,
      kind: "hold",
      memo: "mistaken hold",
      postings: holdPostings(amount(500n)),
    });

    await post(sql, {
      id: testId(),
      kind: "release",
      memo: `reverses ${id}`,
      postings: releasePostings(amount(500n)),
    });

    expect(await balanceOf(sql, "asset:authorization_holds", INR)).toEqual(zero(INR));

    // The history is intact: four entries, not zero.
    const rows = await sql<{ count: bigint }[]>`SELECT COUNT(*) FROM ledger_entries`;
    expect(Number(rows[0]?.count)).toBe(4);
  });
});

describe("the hold and capture lifecycle", () => {
  it("nets the hold to zero on capture and books the fee", async () => {
    const gross = amount(1_499_000n);
    const fee = amount(35_376n);

    await post(sql, { id: testId(), kind: "hold", memo: "hold", postings: holdPostings(gross) });
    await post(sql, {
      id: testId(),
      kind: "capture",
      memo: "capture",
      postings: capturePostings(gross, fee),
    });

    // The hold account is where a status column would have been. Empty
    // means nothing is outstanding, and it is derived rather than asserted.
    expect(await balanceOf(sql, "asset:authorization_holds", INR)).toEqual(zero(INR));
    expect(await balanceOf(sql, "asset:buyer_receivable", INR)).toEqual(zero(INR));

    // What Razorpay will actually settle is gross minus the fee, and the
    // fee is an expense we can reconcile against the settlement report.
    expect(await balanceOf(sql, "asset:razorpay_receivable", INR)).toEqual(amount(1_463_624n));
    expect(await balanceOf(sql, "expense:psp_fees", INR)).toEqual(fee);
    expect(await balanceOf(sql, "revenue:sales", INR)).toEqual(amount(-1_499_000n));
  });

  it("keeps the whole ledger summing to zero across a full lifecycle", async () => {
    const gross = amount(750_000n);

    await post(sql, { id: testId(), kind: "hold", memo: "h1", postings: holdPostings(gross) });
    await post(sql, {
      id: testId(),
      kind: "capture",
      memo: "c1",
      postings: capturePostings(gross, amount(17_700n)),
    });
    await post(sql, {
      id: testId(),
      kind: "hold",
      memo: "h2",
      postings: holdPostings(amount(200_000n)),
    });
    await post(sql, {
      id: testId(),
      kind: "release",
      memo: "r2",
      postings: releasePostings(amount(200_000n)),
    });

    const result = await isInBalance(sql);
    expect(result).toEqual({ ok: true, totals: { INR: "0" } });
  });

  it("reports every account through the derived view", async () => {
    await post(sql, {
      id: testId(),
      kind: "hold",
      memo: "hold",
      postings: holdPostings(amount(1_000n)),
    });

    const rows = await balances(sql, INR);
    const holds = rows.find((r) => r.account === "asset:authorization_holds");

    expect(holds).toMatchObject({ kind: "asset", entryCount: 1 });
    expect(rows.every((r) => r.balance.currency === INR)).toBe(true);
  });
});

describe("atomicity", () => {
  it("rolls the posting back with the caller's transaction", async () => {
    // The ledger must never commit underneath a caller that is still
    // deciding. Spend accounting and the audit record commit with the
    // posting or not at all.
    const id = testId();

    await sql
      .begin(async (tx) => {
        await post(tx, {
          id,
          kind: "hold",
          memo: "will be rolled back",
          postings: holdPostings(amount(4_242n)),
        });
        throw new Error("caller changed its mind");
      })
      .catch(() => undefined);

    expect(await balanceOf(sql, "asset:authorization_holds", INR)).toEqual(zero(INR));

    const rows = await sql<{ count: bigint }[]>`
      SELECT COUNT(*) FROM ledger_transactions WHERE id = ${id}
    `;
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it("rejects a duplicate transaction id", async () => {
    const id = testId();
    const input = {
      id,
      kind: "hold" as const,
      memo: "first",
      postings: holdPostings(amount(100n)),
    };

    await post(sql, input);
    await expect(post(sql, { ...input, memo: "second" })).rejects.toThrow();
  });
});

describe("bigint fidelity", () => {
  it("round-trips an amount beyond the safe integer range", async () => {
    // ₹92,23,37,20,368 crore. Unreachable in practice, but a number-typed
    // driver would round it and the ledger would stop balancing.
    const huge = 9_007_199_254_740_993n;

    await post(sql, {
      id: testId(),
      kind: "hold",
      memo: "beyond 2^53",
      postings: holdPostings(amount(huge)),
    });

    const balance = await balanceOf(sql, "asset:authorization_holds", INR);
    expect(balance.amount).toBe(huge);
    expect(typeof balance.amount).toBe("bigint");
  });
});
