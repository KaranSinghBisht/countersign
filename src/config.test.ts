import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "./config.js";

const VALID: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  COUNTERSIGN_BASE_URL: "https://countersign.example",
  DATABASE_URL: "postgres://countersign:countersign@localhost:5432/countersign",
  RAZORPAY_KEY_ID: "rzp_test_1234567890abcd",
  RAZORPAY_KEY_SECRET: "secret_value_at_least_16",
  RAZORPAY_WEBHOOK_SECRET: "webhook_secret_at_least_16",
  CHALLENGE_HMAC_SECRET: "challenge_secret_at_least_16",
  MANDATE_ISSUER_JWK: "eyJrdHkiOiJFQyJ9",
  AGENT_SIGNING_JWK: "eyJrdHkiOiJFQyJ9",
  CHECKPOINT_JWK: "eyJrdHkiOiJPS1AifQ",
};

describe("parseConfig", () => {
  it("accepts a complete environment and applies defaults", () => {
    const config = parseConfig(VALID);
    expect(config.PORT).toBe(3000);
    expect(config.LOG_LEVEL).toBe("info");
    expect(config.CLOSED_MANDATE_TTL_SECONDS).toBe(120);
  });

  // Razorpay retries for 24 hours. A 5-minute staleness window copied from
  // Stripe would reject exactly the retries we need to accept.
  it("defaults the webhook staleness window to 26 hours, not 5 minutes", () => {
    expect(parseConfig(VALID).WEBHOOK_MAX_AGE_SECONDS).toBe(93_600);
  });

  it("coerces numeric variables from strings, as the environment supplies them", () => {
    expect(parseConfig({ ...VALID, PORT: "8080" }).PORT).toBe(8080);
  });

  // The interlock that matters most in a public hackathon repo: this codebase
  // creates orders and captures payments.
  it("refuses to start with a live Razorpay key", () => {
    const liveKeyId = "rzp_live_1234567890abcd"; // pragma: allow-live-key (synthetic)
    expect(() => parseConfig({ ...VALID, RAZORPAY_KEY_ID: liveKeyId })).toThrow(
      /refuses to run live/,
    );
  });

  it("rejects a missing secret rather than starting without it", () => {
    const { RAZORPAY_WEBHOOK_SECRET: _omitted, ...withoutSecret } = VALID;
    expect(() => parseConfig(withoutSecret)).toThrow(ConfigError);
  });

  it("rejects a placeholder secret that is too short to be real", () => {
    expect(() => parseConfig({ ...VALID, RAZORPAY_KEY_SECRET: "changeme" })).toThrow(/at least 16/);
  });

  it("boots without the unused 402 challenge secret", () => {
    const { CHALLENGE_HMAC_SECRET: _omitted, ...withoutChallenge } = VALID;
    expect(parseConfig(withoutChallenge).CHALLENGE_HMAC_SECRET).toBeUndefined();
  });

  it("still refuses a short challenge secret if one is supplied", () => {
    expect(() => parseConfig({ ...VALID, CHALLENGE_HMAC_SECRET: "changeme" })).toThrow(
      /at least 16/,
    );
  });

  it("rejects a database URL that is not Postgres", () => {
    expect(() => parseConfig({ ...VALID, DATABASE_URL: "mysql://localhost:3306/x" })).toThrow(
      /postgres/,
    );
  });

  it("rejects a malformed base URL", () => {
    expect(() => parseConfig({ ...VALID, COUNTERSIGN_BASE_URL: "countersign.example" })).toThrow(
      ConfigError,
    );
  });

  // Fixing one variable, restarting, and finding the next one is a miserable
  // loop. Report everything at once.
  it("reports every problem in a single error", () => {
    const broken = {
      ...VALID,
      PORT: "not-a-port",
      DATABASE_URL: "nope",
      CHECKPOINT_JWK: "",
    };
    try {
      parseConfig(broken);
      expect.unreachable("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("PORT");
      expect(message).toContain("DATABASE_URL");
      expect(message).toContain("CHECKPOINT_JWK");
    }
  });

  // A malformed DATABASE_URL trips both the URL check and the scheme
  // refinement. Counting raw issues would report more broken variables than
  // there are, which reads like a bug in the validator.
  it("counts broken variables, not validation issues", () => {
    const broken = {
      ...VALID,
      PORT: "not-a-port",
      DATABASE_URL: "nope",
      CHECKPOINT_JWK: "",
    };
    try {
      parseConfig(broken);
      expect.unreachable("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/3 variable\(s\)/);
      expect(message.match(/^ {2}DATABASE_URL:/gm)).toHaveLength(1);
    }
  });

  it("points at .env.example so the fix is obvious", () => {
    expect(() => parseConfig({})).toThrow(/\.env\.example/);
  });
});
