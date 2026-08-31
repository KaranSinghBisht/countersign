import { describe, expect, it } from "vitest";
import { generateSampleKeys, signedWorld } from "../demo/sample-bundle.js";
import type { LoadedBundle } from "./bundle.js";
import { explain } from "./explain.js";

describe("explain --order", () => {
  it("resolves an order through the bundle's receipts when the record carries none", async () => {
    const world = await signedWorld(await generateSampleKeys());
    // What a live export looks like: the record was appended at intent time,
    // before Razorpay had named the order.
    const record = {
      ...world.record,
      external: { ...(world.record.external as object), order_id: null },
    } as typeof world.record;
    const bundle = {
      records: [record],
      receipts: new Map([[world.receipt, world.receiptFile]]),
    } as unknown as LoadedBundle;

    const narrated = explain(bundle, { order: world.receiptFile.order_id as string });
    expect(narrated).toContain(`seq ${record.seq}`);
    expect(narrated).toContain(record.reason);
    expect(explain(bundle, { order: "order_nobody" })).toBeUndefined();
  });
});
