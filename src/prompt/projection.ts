/**
 * The only view of an order an LLM is allowed to see.
 *
 * RBI localization treats an inference call as processing. If the prompt
 * contains payment system data and the model is hosted abroad, we have sent
 * that data out of India. This module is the allow-list: an internal order
 * id, SKUs, integer paise, a currency code, a coarse status. Nothing else
 * is copied, even when the caller hands us a richer object.
 *
 * We do not call an LLM in this repository. The projection exists so the
 * first call cannot invent a wider view.
 */

export const COARSE_STATUSES = [
  "created",
  "denied",
  "escalated",
  "authorized",
  "captured",
  "failed",
] as const;

export type CoarseStatus = (typeof COARSE_STATUSES)[number];

export interface PromptProjection {
  readonly internal_order_id: string;
  readonly skus: readonly string[];
  readonly amount_paise: string;
  readonly currency: string;
  readonly status: CoarseStatus;
}

const ALLOWED = new Set(["internal_order_id", "skus", "amount_paise", "currency", "status"]);

export function projectForPrompt(raw: Record<string, unknown>): PromptProjection {
  const picked: Record<string, unknown> = {};
  for (const key of ALLOWED) {
    if (key in raw) picked[key] = raw[key];
  }

  const skus = Array.isArray(picked.skus)
    ? picked.skus.filter((s): s is string => typeof s === "string")
    : [];

  const status = COARSE_STATUSES.find((s) => s === picked.status);
  if (status === undefined) {
    throw new Error("prompt projection requires a coarse status");
  }

  const amount =
    typeof picked.amount_paise === "bigint"
      ? picked.amount_paise.toString()
      : typeof picked.amount_paise === "string"
        ? picked.amount_paise
        : typeof picked.amount_paise === "number" && Number.isInteger(picked.amount_paise)
          ? String(picked.amount_paise)
          : undefined;

  if (typeof picked.internal_order_id !== "string" || picked.internal_order_id.length === 0) {
    throw new Error("prompt projection requires internal_order_id");
  }
  if (amount === undefined) throw new Error("prompt projection requires integer amount_paise");
  if (typeof picked.currency !== "string" || picked.currency.length !== 3) {
    throw new Error("prompt projection requires a 3-letter currency");
  }

  return {
    internal_order_id: picked.internal_order_id,
    skus,
    amount_paise: amount,
    currency: picked.currency,
    status,
  };
}

/** The string that would be sent. Tests assert against this, not against intent. */
export function renderPrompt(projection: PromptProjection): string {
  const items = projection.skus.length > 0 ? projection.skus.join(", ") : "(no skus)";
  return (
    `Order ${projection.internal_order_id}: ${items} ` +
    `for ${projection.amount_paise} ${projection.currency} (${projection.status}).`
  );
}
