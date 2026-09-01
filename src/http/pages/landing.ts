/**
 * The merchant's front door, for humans.
 *
 * Served at GET /. Assembled from static strings at import time: no database
 * read, no template engine, no external fonts or scripts — the page renders
 * offline and identically on a judge's laptop, because it opens the demo
 * video. The one exception to zero-JS is the inline script below: a
 * reduced-motion guard for the hero loop, and the observer that fires the
 * VERIFIED stamps when they scroll into view. Its exact text is allowed by
 * hash in the CSP (see buildApp), so no other inline script can ever run.
 *
 * Layout: the hero (here) is the pixel checkpoint world — assets/hero-video.mp4
 * over a full-screen stage with decision toasts. Everything below the melt
 * (landing-body.ts, styled by landing-css.ts) is the evidence dossier, per the
 * design handoff. Every claim on the page is reproducible from the repo; do
 * not add one that a command cannot back.
 */

import { landingBody } from "./landing-body.js";
import { landingCss } from "./landing-css.js";

const TITLE = "Countersign — provable agent spending on Razorpay";
const DESCRIPTION =
  "A merchant-side spend gate for AI buyers. Bounded by signed mandates, decided by deterministic code, logged in a Merkle tree, verifiable offline.";

/**
 * The only client JavaScript on the page, exported as one string so the CSP
 * can allow exactly this text by 'sha256-…' hash instead of 'unsafe-inline'.
 * Without JavaScript (or IntersectionObserver) the html "js" class is never
 * added and the stamps are simply visible — stillness, not blanks.
 */
export const landingScript = `
  // Honor reduced motion for the hero loop, which CSS alone cannot pause.
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    var v = document.querySelector(".stage-video");
    if (v) { v.removeAttribute("autoplay"); v.pause(); }
  }
  // The VERIFIED chops stamp themselves when scrolled into view.
  if ("IntersectionObserver" in window) {
    document.documentElement.className += " js";
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.className += " stamped";
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.4 });
    document.querySelectorAll(".stamp-img, .vs-stamp").forEach(function (el) {
      io.observe(el);
    });
  }
`;

/**
 * Rendered once at boot with the deployment's public base URL, because link
 * previews (WhatsApp, Slack, X) require an absolute og:image. With no base
 * URL configured the image tags are simply omitted rather than pointing at a
 * URL that is wrong everywhere but one machine.
 */
export function renderLanding(baseUrl: string): string {
  // Operator-controlled, but it lands inside HTML attributes; escape it
  // rather than trust that a URL never carries a quote.
  const origin = baseUrl
    .replace(/\/+$/, "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
  const ogImage =
    origin === ""
      ? ""
      : `
<meta property="og:image" content="${origin}/hero-poster.jpg">
<meta property="og:url" content="${origin}/">
<meta name="twitter:image" content="${origin}/hero-poster.jpg">`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${TITLE}</title>
<meta name="description" content="${DESCRIPTION}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Countersign">
<meta property="og:title" content="${TITLE}">
<meta property="og:description" content="${DESCRIPTION}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${TITLE}">
<meta name="twitter:description" content="${DESCRIPTION}">${ogImage}
<meta name="theme-color" content="#f7f5ef">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' fill='%23FAFAF6'/%3E%3Cpath d='M6 19h20M6 24h20' stroke='%230E5A43' stroke-width='3'/%3E%3Cpath d='M8 11c3-5 7-5 8 0s5 5 8 0' stroke='%231C2434' stroke-width='2.4' fill='none'/%3E%3C/svg%3E">
<style>${landingCss}</style>
</head>
<body>

<div class="stage">
  <video class="stage-video" src="/hero-video.mp4" poster="/hero-poster.jpg" autoplay muted loop playsinline></video>
  <div class="stage-tint"></div>

  <header class="stage-nav">
    <div class="wordmark">COUNTERSIGN
      <small>n. — a second signature that validates the first</small>
    </div>
    <nav>
      <a href="/agents.md">/agents.md</a>
      <a href="/audit/checkpoint">/audit/checkpoint</a>
      <a href="https://github.com/KaranSinghBisht/countersign">source ↗</a>
    </nav>
  </header>

  <div class="stage-copy">
    <div class="inner">
      <p class="eyebrow rise">Merchant-side spend gate · Razorpay test mode</p>
      <h1>
        <span class="l1 rise d1">An agent can spend money.</span>
        <span class="rise d2">Prove it was allowed&nbsp;to.</span>
      </h1>
      <p class="sub rise d3">
        Every purchase an AI buyer makes here is bounded by a human-signed
        mandate, decided by code no model can reach, and logged as proof a
        stranger can verify offline — with this server switched off.
      </p>
      <div class="stage-cta rise d4">
        <a class="btn btn-solid" href="/agents.md">Read the agent contract</a>
        <a class="btn btn-ghost" href="#evidence">See the evidence ↓</a>
      </div>
    </div>
  </div>

  <div class="toasts" aria-hidden="true">
    <div class="toast t1"><i class="dot ok"></i>ALLOW — ₹14,990 to vnd_1042, within budget</div>
    <div class="toast t2"><i class="dot no"></i>DENY — R-BUD-INR, would exceed ₹2,50,000</div>
    <div class="toast t3"><i class="dot esc"></i>ESCALATE — above ₹20,000, asks a human</div>
  </div>

  <div class="stage-fade"></div>
</div>
${landingBody}
<script>${landingScript}</script>

</body>
</html>
`;
}
