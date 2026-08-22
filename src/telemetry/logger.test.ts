import { Writable } from "node:stream";
import type { Logger } from "pino";
import { describe, expect, it } from "vitest";
import { createLogger, currentRequestContext, withRequestContext } from "./logger.js";

const TEST_PAN = "4111111111111111";
const TEST_JWT =
  "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c3JfMSIsImV4cCI6OTk5OTk5OTk5OX0.MEUCIQDx7bQ8kZvW3nT2pLm";

/**
 * The real logger, pointed at an in-memory sink.
 *
 * Deliberately not a lookalike built from the same pieces: the bugs this file
 * exists to catch are ones where a redaction hook is missing from the actual
 * configuration, and a reimplementation in the test would reproduce whatever
 * the source got wrong.
 */
function captureLogger(): { lines: () => Record<string, unknown>[]; log: Logger } {
  const captured: string[] = [];
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      captured.push(chunk.toString());
      callback();
    },
  });

  return {
    log: createLogger({ level: "trace" }, sink),
    lines: () =>
      captured
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe("logger", () => {
  it("emits structured JSON with a level and an ISO timestamp", () => {
    const { log, lines } = captureLogger();
    log.info({ order_id: "order_1" }, "created");

    const [line] = lines();
    expect(line).toMatchObject({ level: "info", msg: "created", order_id: "order_1" });
    expect(line?.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // Redaction lives in the formatter precisely so a call site cannot opt out.
  it("redacts through the formatter, not at the call site", () => {
    const { log, lines } = captureLogger();
    log.info({ email: "karan@example.com", order_id: "order_1" }, "checkout");

    expect(lines()[0]).toMatchObject({ email: "[redacted]", order_id: "order_1" });
  });

  it("lets no PAN, JWT or email reach the sink", () => {
    const { log, lines } = captureLogger();
    log.info(
      {
        customer: { email: "karan@example.com", pan: TEST_PAN },
        mandate: TEST_JWT,
        amount_paise: 149900,
      },
      `charging ${TEST_PAN} for karan@example.com`,
    );

    const raw = JSON.stringify(lines());
    expect(raw).not.toContain(TEST_PAN);
    expect(raw).not.toContain("karan@example.com");
    expect(raw).not.toContain("eyJhbGci");
    expect(raw).toContain("149900");
  });

  // The most natural way to leak a card number is a template literal, and
  // pino appends the message AFTER formatters.log has run — so the formatter
  // alone does not close this.
  it("scrubs the message string, not just the merge object", () => {
    const { log, lines } = captureLogger();
    log.info(`charging ${TEST_PAN} for karan@example.com`);

    const msg = lines()[0]?.msg as string;
    expect(msg).toBe("charging [redacted:pan] for [redacted:email]");
  });

  it("scrubs interpolation arguments too", () => {
    const { log, lines } = captureLogger();
    log.info("charging %s", TEST_PAN);

    expect(JSON.stringify(lines())).not.toContain(TEST_PAN);
  });

  // pino serializes `err` through a separate path that would otherwise skip
  // the formatter entirely.
  it("redacts errors, which take a different path through pino", () => {
    const { log, lines } = captureLogger();
    log.error({ err: new Error(`upstream rejected karan@example.com`) }, "capture failed");

    const raw = JSON.stringify(lines());
    expect(raw).not.toContain("karan@example.com");
    expect(raw).toContain("[redacted:email]");
  });

  // An error object that is redacted into unreadability is not a win: the
  // next person on call needs the type and the message.
  it("keeps the error readable after redacting it", () => {
    const { log, lines } = captureLogger();
    log.error({ err: new TypeError("capture failed after 3 attempts") }, "giving up");

    expect(lines()[0]?.err).toMatchObject({
      error_name: "TypeError",
      error_message: "capture failed after 3 attempts",
    });
  });

  it("follows an error cause chain", () => {
    const { log, lines } = captureLogger();
    const cause = new Error("connection reset by karan@example.com");
    log.error({ err: new Error("capture failed", { cause }) }, "giving up");

    const err = lines()[0]?.err as Record<string, unknown>;
    expect(err.error_cause).toMatchObject({
      error_message: "connection reset by [redacted:email]",
    });
  });

  it("does not throw on a bigint amount", () => {
    const { log, lines } = captureLogger();
    expect(() => log.info({ amount_paise: 149900n }, "captured")).not.toThrow();
    expect(lines()[0]).toMatchObject({ amount_paise: "149900" });
  });
});

describe("request context", () => {
  it("attaches the request id to every line inside the scope", () => {
    const { log, lines } = captureLogger();

    withRequestContext({ request_id: "req_abc", route: "/acp/checkout_sessions" }, () => {
      log.info({ order_id: "order_1" }, "created");
      log.info({ order_id: "order_2" }, "captured");
    });

    for (const line of lines()) {
      expect(line).toMatchObject({ request_id: "req_abc", route: "/acp/checkout_sessions" });
    }
  });

  // The correlation id has to survive to the deepest ledger write, which is
  // several awaits away from the handler that established it.
  it("survives across await boundaries", async () => {
    const { log, lines } = captureLogger();

    await withRequestContext({ request_id: "req_async" }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      log.info({ order_id: "order_1" }, "after await");
    });

    expect(lines()[0]).toMatchObject({ request_id: "req_async" });
  });

  it("does not leak context to lines logged outside the scope", () => {
    const { log, lines } = captureLogger();

    withRequestContext({ request_id: "req_inside" }, () => log.info("inside"));
    log.info("outside");

    const [inside, outside] = lines();
    expect(inside?.request_id).toBe("req_inside");
    expect(outside?.request_id).toBeUndefined();
  });

  it("reports no context when there is none", () => {
    expect(currentRequestContext()).toBeUndefined();
  });
});
