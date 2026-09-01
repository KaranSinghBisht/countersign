/**
 * GET /architecture — the one-screen system diagram, served by the merchant
 * itself like every other discovery document. Deliberately zero JavaScript:
 * the default CSP pins exactly one script hash (the landing page's), and this
 * page needs none.
 */

export const architectureHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Countersign — architecture</title>
<meta name="robots" content="noindex">
<style>
  body { margin: 0; background: #10151c; color: #dfe7ef; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  main { max-width: 1720px; margin: 0 auto; padding: 20px 16px 40px; }
  p.bar { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin: 0 0 14px; color: #8fa3b8; }
  a { color: #7fc7ad; }
  img { display: block; width: 100%; height: auto; border: 1px solid #24303e; border-radius: 10px; }
</style>
</head>
<body>
<main>
  <p class="bar"><span>countersign — the whole system, one screen</span><span><a href="/assets/architecture.png">raw png</a> · <a href="/">home</a> · <a href="/agents.md">/agents.md</a></span></p>
  <img src="/assets/architecture.png" alt="Countersign architecture: principals sign mandates, the gate verifies and decides, one Postgres transaction commits, the worker drives Razorpay, and the audit log exports to an offline verifier" width="1672" height="941">
</main>
</body>
</html>
`;
