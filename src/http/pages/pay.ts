/**
 * The payer page: `GET /pay/:order_id`.
 *
 * The agent's purchase ends with a Razorpay order; someone still has to pay
 * it. In a real deployment that is the buyer's principal through whatever
 * instrument they hold. Here it is Razorpay's own Checkout, in test mode,
 * against the order the worker created — so the money side of the loop can
 * be walked for real: order → payment → signature → capture → webhook.
 *
 * Nothing here decides anything. The page cannot change an amount (Checkout
 * takes the amount from the order Razorpay holds), and the callback it posts
 * is verified with the key secret before it is believed.
 */

import { type CurrencyCode, format, money } from "../../money/money.js";

export interface PayPageInput {
  readonly keyId: string;
  readonly orderId: string;
  readonly receipt: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly state: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Safe inside a <script> string literal: no quotes, no tags, no line breaks survive. */
function scriptString(value: string): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function amountLabel(amountMinor: bigint, currency: string): string {
  return ["INR", "USD", "JPY"].includes(currency)
    ? format(money(amountMinor, currency as CurrencyCode))
    : `${amountMinor} ${currency}`;
}

export function renderPayPage(input: PayPageInput): string {
  const amount = amountLabel(input.amountMinor, input.currency);
  const settled = input.state === "captured" || input.state === "refunded";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Pay ${escapeHtml(amount)} — Countersign (test mode)</title>
<style>
  :root { --paper: #f7f5ef; --ink: #182235; --soft: #5b6678; --ledger: #08745d; --deny: #c33b31; --rule: #d9d5ca; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--paper); color: var(--ink); font: 16px/1.5 Georgia, "Times New Roman", serif; }
  main { max-width: 520px; margin: 8vh auto; padding: 0 20px; }
  .card { background: #fffdf8; border: 1px solid var(--rule); border-radius: 12px; padding: 28px; box-shadow: 0 18px 45px rgba(24,34,53,.08); }
  .eyebrow { font: 12px/1 ui-monospace, Menlo, monospace; letter-spacing: .14em; text-transform: uppercase; color: var(--ledger); margin: 0 0 14px; }
  h1 { font-size: 30px; margin: 0 0 6px; }
  dl { display: grid; grid-template-columns: 110px 1fr; gap: 6px 12px; margin: 18px 0; font: 13.5px/1.6 ui-monospace, Menlo, monospace; }
  dt { color: var(--soft); } dd { margin: 0; overflow-wrap: anywhere; }
  button { font: 600 16px/1 Georgia, serif; background: var(--ledger); color: #fff; border: 0; border-radius: 8px; padding: 14px 22px; cursor: pointer; width: 100%; }
  button[disabled] { opacity: .5; cursor: default; }
  .note { font-size: 13.5px; color: var(--soft); margin-top: 16px; }
  #result { margin-top: 18px; font: 13.5px/1.6 ui-monospace, Menlo, monospace; white-space: pre-wrap; }
  .ok { color: var(--ledger); } .bad { color: var(--deny); }
</style>
</head>
<body>
<main>
  <div class="card">
    <p class="eyebrow">Razorpay · test mode · order ${escapeHtml(input.orderId)}</p>
    <h1>${escapeHtml(amount)}</h1>
    <p>An agent was allowed to buy this. The human pays it.</p>
    <dl>
      <dt>receipt</dt><dd>${escapeHtml(input.receipt)}</dd>
      <dt>state</dt><dd id="state">${escapeHtml(input.state)}</dd>
    </dl>
    <button id="pay" type="button"${settled ? " disabled" : ""}>${settled ? "Already settled" : `Pay ${escapeHtml(amount)} with Razorpay`}</button>
    <p class="note">Test mode: Netbanking → any bank → Success, or domestic test card 5267 3181 8797 5449 (any future expiry, any CVV). 4111… is an international card and is refused by default. No money moves.</p>
    <div id="result"></div>
  </div>
</main>
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
<script>
(function () {
  var orderId = ${scriptString(input.orderId)};
  var out = document.getElementById("result");
  var button = document.getElementById("pay");
  function show(text, cls) { out.textContent = text; out.className = cls; }
  function complete(response) {
    show("verifying Razorpay's signature on our side…", "");
    fetch("/pay/" + encodeURIComponent(orderId) + "/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        razorpay_payment_id: response.razorpay_payment_id,
        razorpay_order_id: response.razorpay_order_id,
        razorpay_signature: response.razorpay_signature
      })
    }).then(function (r) { return r.json().then(function (body) { return { status: r.status, body: body }; }); })
      .then(function (r) {
        show(JSON.stringify(r.body, null, 2), r.status === 200 ? "ok" : "bad");
        if (r.status === 200) { document.getElementById("state").textContent = "authorized → capture queued"; button.disabled = true; }
      })
      .catch(function (error) { show(String(error), "bad"); });
  }
  button.addEventListener("click", function () {
    var checkout = new Razorpay({
      key: ${scriptString(input.keyId)},
      order_id: orderId,
      name: "Countersign",
      description: "receipt " + ${scriptString(input.receipt)},
      // Checkout asks for an email it has no use for here; prefilled so the
      // test payment is card number, expiry, CVV and done.
      prefill: { email: "payer@countersign.example" },
      // No "save this card" prompt: its OTP goes to a number nobody holds.
      remember_customer: false,
      theme: { color: "#08745d" },
      handler: complete,
      modal: { ondismiss: function () { show("checkout closed without paying", ""); } }
    });
    checkout.on("payment.failed", function (event) {
      show("payment failed: " + (event.error && event.error.description ? event.error.description : "unknown"), "bad");
    });
    checkout.open();
  });
})();
</script>
</body>
</html>
`;
}

/** What the browser may load on the payer page and nowhere else. */
export const PAY_PAGE_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline' https://checkout.razorpay.com; " +
  "frame-src https://api.razorpay.com https://checkout.razorpay.com; " +
  "connect-src 'self' https://api.razorpay.com https://lumberjack.razorpay.com https://lumberjack-cx.razorpay.com; " +
  "img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; " +
  "frame-ancestors 'none'; base-uri 'self'; form-action 'none'";
