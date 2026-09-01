/**
 * The landing page stylesheet. Palette and rhythm follow the design handoff
 * (design-tokens.css): warm paper, navy ink, forest-green verification,
 * one dark forensic band. Pixel art renders nearest-neighbor via .pixel.
 *
 * The .stage-fade background is a generated dissolve tile — see the note in
 * landing.ts; regenerate rather than hand-editing the data URI.
 */

export const landingCss = `
  :root {
    --paper: #f7f5ef;
    --paper2: #efece3;
    --card: #fffdf8;
    --ink: #182235;
    --ink-soft: #5b6678;
    --ledger: #08745d;
    --ledger-dark: #075946;
    --deny: #c33b31;
    --amber: #c98b1f;
    --rule: #d9d5ca;
    --chip: #efece3;
    --terminal: #1b2638;
    --serif: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif;
    --mono: ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { scroll-behavior: smooth; }
  body {
    background: var(--paper);
    color: var(--ink);
    font-family: var(--serif);
    font-size: 17px;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
    overflow-x: clip;
  }
  a { color: var(--ledger); text-decoration: none; }
  a:hover { text-decoration: underline; text-underline-offset: 3px; }
  a:focus-visible { outline: 2px solid var(--ledger); outline-offset: 3px; border-radius: 1px; }
  code, .mono { font-family: var(--mono); }
  img { height: auto; }
  img.pixel { image-rendering: pixelated; image-rendering: crisp-edges; }
  .wrap { max-width: 1200px; margin: 0 auto; padding: 0 28px; }

  .eyebrow {
    font-family: var(--mono); font-size: 12px; letter-spacing: 0.14em;
    text-transform: uppercase; color: var(--ledger);
  }

  /* ---- the stage: full-screen hero over the checkpoint loop ----
     120px taller than the viewport so the melt edge sits below the fold. */
  .stage { position: relative; height: calc(100vh + 120px); height: calc(100svh + 120px); min-height: 760px; overflow: hidden; background: #6db3e4; }
  .stage-video {
    position: absolute; inset: 0; width: 100%; height: 100%;
    object-fit: cover; object-position: 50% 38%;
    /* Zoomed past its own frame: the generator's watermark sits in the
       bottom-right corner of the source, and the origin is biased up-left so
       that corner is what the overflow crop discards. */
    transform: scale(1.16);
    transform-origin: 25% 30%;
  }
  .stage-tint {
    position: absolute; inset: 0; pointer-events: none;
    background:
      linear-gradient(to bottom, rgba(8, 22, 36, 0.38), rgba(8, 22, 36, 0) 140px),
      linear-gradient(105deg, rgba(8, 24, 40, 0.44) 0%, rgba(8, 24, 40, 0.16) 38%, rgba(8, 24, 40, 0) 60%);
  }

  .stage-nav {
    position: absolute; top: 0; left: 0; right: 0; z-index: 3;
    display: flex; align-items: center; justify-content: space-between; gap: 16px;
    max-width: 1200px; margin: 0 auto; padding: 22px 28px;
  }
  .stage-nav .wordmark {
    font-family: var(--mono); font-size: 15px; letter-spacing: 0.22em; font-weight: 700;
    color: #fff; text-shadow: 0 1px 12px rgba(0, 20, 40, 0.45);
  }
  .stage-nav .wordmark small {
    display: block; margin-top: 4px; letter-spacing: 0.02em; font-weight: 400;
    font-size: 11.5px; color: rgba(255, 255, 255, 0.82); text-transform: none;
  }
  .stage-nav nav {
    display: flex; gap: 4px; align-items: center;
    background: rgba(10, 22, 16, 0.42); border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 999px; padding: 6px 8px; backdrop-filter: blur(6px);
  }
  .stage-nav nav a {
    color: #fff; font-family: var(--mono); font-size: 13px;
    padding: 6px 12px; border-radius: 999px;
  }
  .stage-nav nav a:hover { background: rgba(255, 255, 255, 0.14); text-decoration: none; }

  .stage-copy {
    position: absolute; z-index: 2; left: 0; right: 0; top: 21%;
    max-width: 1200px; margin: 0 auto; padding: 0 28px;
  }
  .stage-copy .inner { max-width: 600px; }
  .stage-copy .eyebrow { color: rgba(255, 255, 255, 0.85); text-shadow: 0 1px 10px rgba(0, 20, 40, 0.4); }
  .stage-copy h1 {
    margin-top: 16px; color: #fff; font-weight: 600;
    font-size: clamp(38px, 4.8vw, 62px); line-height: 1.05; letter-spacing: -0.012em;
    text-shadow: 0 2px 26px rgba(0, 20, 40, 0.45);
  }
  .stage-copy h1 .l1 { display: block; font-weight: 400; font-style: italic; color: rgba(255, 255, 255, 0.88); }
  .stage-copy .sub {
    margin-top: 20px; max-width: 30em; color: rgba(255, 255, 255, 0.94);
    font-size: 18.5px; text-shadow: 0 1px 14px rgba(0, 20, 40, 0.45);
  }
  .stage-cta { margin-top: 28px; display: flex; gap: 12px; flex-wrap: wrap; }
  .btn {
    font-family: var(--mono); font-size: 14px; border-radius: 999px;
    padding: 12px 22px; display: inline-block;
  }
  .btn-solid { background: var(--paper); color: var(--ink); box-shadow: 0 4px 18px rgba(0, 20, 40, 0.25); }
  .btn-solid:hover { text-decoration: none; transform: translateY(-1px); }
  .btn-ghost { border: 1px solid rgba(255, 255, 255, 0.55); color: #fff; }
  .btn-ghost:hover { text-decoration: none; background: rgba(255, 255, 255, 0.12); }
  .btn-green { background: var(--ledger); color: #fff; box-shadow: 0 6px 20px rgba(8, 116, 93, 0.28); }
  .btn-green:hover { text-decoration: none; background: var(--ledger-dark); }
  .btn-line { border: 1.5px solid var(--ledger); color: var(--ledger); }
  .btn-line:hover { text-decoration: none; background: rgba(8, 116, 93, 0.08); }

  /* Right edge pinned to the wrap's content edge so the toasts line up
     exactly under the nav pill at every viewport width. */
  .toasts {
    position: absolute; z-index: 2; top: 15%;
    right: max(28px, calc((100% - 1200px) / 2 + 28px));
    display: flex; flex-direction: column; gap: 10px; align-items: flex-end;
  }
  .toast {
    display: flex; align-items: center; gap: 9px;
    background: rgba(16, 26, 20, 0.78); border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 7px; padding: 9px 14px; backdrop-filter: blur(5px);
    color: rgba(255, 255, 255, 0.95); font-family: var(--mono); font-size: 12.5px;
    box-shadow: 0 8px 24px rgba(0, 20, 40, 0.25);
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 8px; }
  .dot.ok { background: #4CC38A; } .dot.no { background: #E5645B; } .dot.esc { background: #E3A93C; }

  .stage-fade {
    position: absolute; z-index: 2; left: 0; right: 0; bottom: -1px; height: 64px; pointer-events: none;
    background-image: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22660%22%20height%3D%2264%22%20shape-rendering%3D%22crispEdges%22%3E%3Cg%20fill%3D%22%23FAFAF6%22%3E%3Crect%20x%3D%22186%22%20y%3D%220%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22270%22%20y%3D%220%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22282%22%20y%3D%220%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22372%22%20y%3D%220%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22576%22%20y%3D%220%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22636%22%20y%3D%220%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%2224%22%20y%3D%226%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%2236%22%20y%3D%226%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22144%22%20y%3D%226%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22186%22%20y%3D%226%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22240%22%20y%3D%226%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22252%22%20y%3D%226%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22288%22%20y%3D%226%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22300%22%20y%3D%226%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22468%22%20y%3D%226%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22492%22%20y%3D%226%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22516%22%20y%3D%226%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22534%22%20y%3D%226%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22546%22%20y%3D%226%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22576%22%20y%3D%226%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22588%22%20y%3D%226%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%226%22%20y%3D%2212%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%2224%22%20y%3D%2212%22%20width%3D%2218%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%2284%22%20y%3D%2212%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%2296%22%20y%3D%2212%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22144%22%20y%3D%2212%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22192%22%20y%3D%2212%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22204%22%20y%3D%2212%22%20width%3D%2224%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22234%22%20y%3D%2212%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22252%22%20y%3D%2212%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22288%22%20y%3D%2212%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22300%22%20y%3D%2212%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22312%22%20y%3D%2212%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22396%22%20y%3D%2212%22%20width%3D%2212%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22438%22%20y%3D%2212%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22468%22%20y%3D%2212%22%20width%3D%2218%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22492%22%20y%3D%2212%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22510%22%20y%3D%2212%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22558%22%20y%3D%2212%22%20width%3D%2224%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22630%22%20y%3D%2212%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22648%22%20y%3D%2212%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%226%22%20y%3D%2218%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%2236%22%20y%3D%2218%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%2260%22%20y%3D%2218%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%2272%22%20y%3D%2218%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%2284%22%20y%3D%2218%22%20width%3D%2224%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22114%22%20y%3D%2218%22%20width%3D%2212%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22132%22%20y%3D%2218%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22150%22%20y%3D%2218%22%20width%3D%2218%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22174%22%20y%3D%2218%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22192%22%20y%3D%2218%22%20width%3D%2212%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22216%22%20y%3D%2218%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22252%22%20y%3D%2218%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22294%22%20y%3D%2218%22%20width%3D%2212%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22324%22%20y%3D%2218%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22348%22%20y%3D%2218%22%20width%3D%2212%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22402%22%20y%3D%2218%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22414%22%20y%3D%2218%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22426%22%20y%3D%2218%22%20width%3D%2218%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22450%22%20y%3D%2218%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22468%22%20y%3D%2218%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22480%22%20y%3D%2218%22%20width%3D%2224%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22510%22%20y%3D%2218%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22522%22%20y%3D%2218%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22540%22%20y%3D%2218%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22552%22%20y%3D%2218%22%20width%3D%2230%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22588%22%20y%3D%2218%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22606%22%20y%3D%2218%22%20width%3D%2224%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%220%22%20y%3D%2224%22%20width%3D%2212%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%2218%22%20y%3D%2224%22%20width%3D%2218%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%2242%22%20y%3D%2224%22%20width%3D%2224%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%2278%22%20y%3D%2224%22%20width%3D%2224%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22120%22%20y%3D%2224%22%20width%3D%2212%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22144%22%20y%3D%2224%22%20width%3D%2218%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22198%22%20y%3D%2224%22%20width%3D%2242%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22246%22%20y%3D%2224%22%20width%3D%2218%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22288%22%20y%3D%2224%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22300%22%20y%3D%2224%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22312%22%20y%3D%2224%22%20width%3D%2212%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22348%22%20y%3D%2224%22%20width%3D%2242%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22402%22%20y%3D%2224%22%20width%3D%2242%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22462%22%20y%3D%2224%22%20width%3D%2224%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22492%22%20y%3D%2224%22%20width%3D%2212%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22510%22%20y%3D%2224%22%20width%3D%2248%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22564%22%20y%3D%2224%22%20width%3D%2212%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22582%22%20y%3D%2224%22%20width%3D%2260%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22648%22%20y%3D%2224%22%20width%3D%226%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%220%22%20y%3D%2230%22%20width%3D%2212%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%2218%22%20y%3D%2230%22%20width%3D%2218%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%2242%22%20y%3D%2230%22%20width%3D%2230%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%2278%22%20y%3D%2230%22%20width%3D%22162%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22246%22%20y%3D%2230%22%20width%3D%2278%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22330%22%20y%3D%2230%22%20width%3D%2212%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22348%22%20y%3D%2230%22%20width%3D%2224%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22378%22%20y%3D%2230%22%20width%3D%2254%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22438%22%20y%3D%2230%22%20width%3D%22186%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%22630%22%20y%3D%2230%22%20width%3D%2230%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%220%22%20y%3D%2236%22%20width%3D%22660%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%220%22%20y%3D%2242%22%20width%3D%22660%22%20height%3D%226%22%2F%3E%3Crect%20x%3D%220%22%20y%3D%2248%22%20width%3D%22660%22%20height%3D%2216%22%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E");
    background-size: 660px 64px;
    background-position: left bottom;
    background-repeat: repeat-x;
  }

  /* ---- shared section rhythm ---- */
  section { padding-block: clamp(72px, 8vw, 120px); }
  section.compact { padding-block: clamp(48px, 6vw, 72px); }
  .sec-head { display: flex; align-items: baseline; gap: 18px; margin-bottom: 34px; }
  .sec-head h2 { font-size: clamp(24px, 2.6vw, 30px); font-weight: 600; letter-spacing: -0.01em; }

  /* ---- proof metrics strip ---- */
  .stats { padding: 46px 0 0; text-align: center; }
  .stats-row { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
  .stat {
    background: var(--card); border: 1px solid var(--rule); border-radius: 3px;
    font-family: var(--mono); font-size: 13px; color: var(--ink);
    padding: 10px 18px;
  }
  .stat b { color: var(--ledger); font-weight: 700; }
  .stats-cap { margin-top: 14px; font-size: 14px; color: var(--ink-soft); font-style: italic; }
  .stats-cap code { font-style: normal; font-size: 12.5px; background: var(--chip); padding: 1px 6px; border-radius: 2px; }

  /* ---- 1. the category ---- */
  .cat-grid { display: grid; grid-template-columns: 1fr auto 1.35fr auto 1fr; gap: 16px; align-items: stretch; }
  .cat-card {
    background: var(--card); border: 1px solid var(--rule); border-radius: 4px;
    padding: 22px 24px;
  }
  .cat-card h3 { font-size: 18px; font-weight: 600; }
  .cat-card .role { font-family: var(--mono); font-size: 11.5px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-soft); margin-bottom: 8px; }
  .cat-card p { font-size: 14.5px; color: var(--ink-soft); margin-top: 8px; }
  .cat-card .note { font-size: 13px; font-style: italic; margin-top: 12px; }
  .cat-main { border: 2px solid var(--ledger); box-shadow: 0 18px 45px rgba(24, 34, 53, 0.09); position: relative; }
  .cat-main .role { color: var(--ledger); }
  .cat-main ul { list-style: none; margin-top: 12px; }
  .cat-main li { font-family: var(--mono); font-size: 13px; line-height: 2; }
  .cat-main li::before { content: "▸ "; color: var(--ledger); }
  .cat-gate { position: absolute; top: -66px; right: -18px; width: 108px; filter: drop-shadow(0 10px 14px rgba(24, 34, 53, 0.18)); }
  .cat-arrow { align-self: center; font-family: var(--mono); font-size: 18px; color: var(--ink-soft); }
  .cat-quote {
    margin: 40px auto 0; max-width: 46em; text-align: center;
    font-style: italic; font-size: 17.5px; color: var(--ink-soft);
  }

  /* ---- 2. the record, in the open ---- */
  .statement h2 {
    text-align: center; font-weight: 600; letter-spacing: -0.01em;
    font-size: clamp(26px, 3.2vw, 38px); line-height: 1.2;
  }
  .statement h2 span { display: block; color: var(--ink-soft); font-weight: 400; }
  .evi-grid { display: grid; grid-template-columns: 1.15fr 0.85fr; gap: 52px; align-items: center; margin-top: 48px; }
  .artifact { position: relative; padding-top: 44px; }
  .record {
    background: var(--card); border: 1px solid var(--rule); border-radius: 3px;
    box-shadow: 0 18px 45px rgba(24, 34, 53, 0.07);
    font-family: var(--mono); font-size: 12.75px; line-height: 1.75; color: var(--ink);
    padding: 18px 20px 20px; overflow-x: auto;
  }
  .record-head {
    display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap;
    padding-bottom: 12px; margin-bottom: 14px; border-bottom: 1px solid var(--rule);
    color: var(--ink-soft); font-size: 12px; letter-spacing: 0.05em;
  }
  .record table { border-collapse: collapse; width: 100%; }
  .record td { vertical-align: top; padding: 1px 0; }
  .record td.k { color: var(--ink-soft); width: 118px; padding-right: 14px; white-space: nowrap; }
  .record .dim { color: var(--ink-soft); }
  .record .sum td { border-top: 1px solid var(--rule); padding-top: 5px; }
  .record .sum td:last-child { border-bottom: 3px double var(--ink); padding-bottom: 5px; }
  .record .note { color: var(--ledger); font-style: italic; }
  .record .allow { color: var(--ledger); font-weight: 700; letter-spacing: 0.08em; }
  .record-caption { margin-top: 12px; font-size: 13px; color: var(--ink-soft); }
  /* The SVG carries transparent padding for its rotated corners; the size
     and offsets compensate so the visible stamp sits where it did. */
  .stamp-img { position: absolute; top: -12px; right: -20px; width: 218px; pointer-events: none; }

  .stilllife { position: relative; min-height: 380px; }
  .stilllife img { position: absolute; filter: drop-shadow(0 16px 18px rgba(24, 34, 53, 0.14)); }
  .sl-ledger { left: 2%; bottom: 4%; width: 250px; }
  .sl-lock { right: 4%; bottom: 30%; width: 200px; }
  .sl-token { left: 30%; top: 0; width: 150px; }

  .traits { display: grid; grid-template-columns: repeat(3, 1fr); gap: 26px; margin-top: 60px; }
  .trait { border-top: 2px solid var(--ledger); padding-top: 14px; }
  .trait h3 { font-size: 17px; font-weight: 600; }
  .trait p { font-size: 14px; color: var(--ink-soft); margin-top: 6px; }

  /* ---- 3. the gate rail ---- */
  .rail { position: relative; display: flex; gap: 16px; align-items: stretch; padding-block: 10px; }
  .rail::before {
    content: ""; position: absolute; left: 0; right: 0; top: 50%; height: 2px;
    background: var(--rule);
  }
  .rail::after {
    content: ""; position: absolute; left: 0; right: 0; top: 50%; height: 2px;
    background: var(--ledger); transform-origin: left center; transform: scaleX(1);
  }
  .node {
    position: relative; z-index: 1;
    background: var(--card); border: 1px solid var(--rule); border-radius: 4px;
    padding: 15px 16px; flex: 1 1 150px; min-width: 150px;
  }
  .node h3 { font-family: var(--mono); font-size: 13px; letter-spacing: 0.04em; }
  .node p { font-size: 13.5px; color: var(--ink-soft); margin-top: 6px; line-height: 1.45; }
  .node.gate { border: 2px solid var(--ledger); box-shadow: 0 14px 30px rgba(8, 116, 93, 0.12); flex: 1.55 1 230px; }
  .node.gate h3 { color: var(--ledger); }
  .boundary { margin-top: 20px; font-family: var(--mono); font-size: 12.5px; color: var(--ledger); }
  .inject-row { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
  .inject-row img { width: 30px; flex: 0 0 30px; }
  .injection { font-family: var(--mono); font-size: 12.5px; color: var(--ink-soft); }
  .injection s { color: var(--deny); }

  /* ---- 4. judging bar scorecard ---- */
  #scorecard {
    background-image: url("/assets/merkle-grid.svg");
    background-repeat: no-repeat;
    background-position: right -80px top 40px;
  }
  .score { width: 100%; border-collapse: collapse; }
  .score th, .score td { text-align: left; padding: 12px 18px 12px 0; border-bottom: 1px solid var(--rule); vertical-align: top; }
  .score th { font-size: 16.5px; font-weight: 600; width: 170px; white-space: nowrap; }
  .score td { font-family: var(--mono); font-size: 13px; color: var(--ink-soft); line-height: 1.6; }
  .score td b { color: var(--ink); font-weight: 600; }
  .score tr:last-child th, .score tr:last-child td { border-bottom: 3px double var(--ink); }
  .ok { color: var(--ledger); font-weight: 700; }

  /* ---- 5. break it: the forensic band ---- */
  .band { background: var(--terminal); color: #f2f0e8; }
  .band .eyebrow { color: #7fc7ad; }
  .band .sec-head { margin-bottom: 26px; }
  .band-token { width: 46px; margin-bottom: 14px; }
  .breaks { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; }
  .break {
    background: rgba(255, 255, 255, 0.045); border: 1px solid rgba(255, 255, 255, 0.12);
    border-left: 3px solid #e5645b;
    border-radius: 3px; padding: 16px 18px; font-family: var(--mono); font-size: 12.75px; line-height: 1.65;
  }
  .break h3 { font-size: 13px; letter-spacing: 0.05em; }
  .break p { color: #aab4c5; margin-top: 8px; }
  .break .verdict { margin-top: 10px; color: #ff9d94; font-weight: 700; }
  .breaks-foot { margin-top: 20px; font-size: 14.5px; color: #aab4c5; font-style: italic; max-width: 46em; }
  .breaks-foot .mono { color: #d7dce6; }

  /* ---- 6. verify it yourself ---- */
  .verify-grid { display: grid; grid-template-columns: 1.8fr 1fr; gap: 44px; align-items: start; }
  .term {
    background: var(--terminal); color: #E9E7DE; border-radius: 4px;
    font-family: var(--mono); font-size: 13.5px; line-height: 1.85;
    padding: 22px 26px; overflow-x: auto; box-shadow: 0 16px 40px rgba(24, 34, 53, 0.18);
    white-space: pre;
  }
  .term .p { color: #8A93A8; }
  .term .g { color: #63C7A2; font-weight: 700; }
  .term .r { color: #E38079; font-weight: 700; }
  .cur { display: inline-block; width: 8px; height: 15px; background: #63C7A2; vertical-align: -2px; }
  .term-foot { margin-top: 16px; font-size: 14.5px; color: var(--ink-soft); max-width: 48em; }
  .verify-side { position: relative; padding-top: 8px; }
  .vs-art { position: relative; height: 190px; margin-bottom: 18px; }
  .vs-lock { position: absolute; left: 0; top: 0; width: 170px; filter: drop-shadow(0 12px 16px rgba(24, 34, 53, 0.14)); }
  /* Off the chest's face: the stamp's small line has to sit on paper to be legible. */
  .vs-stamp { position: absolute; left: 150px; top: 72px; width: 196px; }
  .verify-side ul { list-style: none; }
  .verify-side li { font-family: var(--mono); font-size: 13px; line-height: 1.6; padding: 8px 0 8px 24px; position: relative; border-bottom: 1px solid var(--rule); }
  .verify-side li::before { content: "✓"; position: absolute; left: 2px; color: var(--ledger); font-weight: 700; }

  /* ---- 7. shipping now ---- */
  .status-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
  .panel { background: var(--card); border: 1px solid var(--rule); border-radius: 4px; padding: 24px 28px; }
  .panel h3 { font-size: 17px; font-weight: 600; margin-bottom: 12px; }
  .panel ul { list-style: none; }
  .panel li { font-family: var(--mono); font-size: 13.5px; line-height: 1.5; padding: 7px 0 7px 26px; position: relative; }
  .panel.ship li::before { content: "✓"; position: absolute; left: 2px; color: var(--ledger); font-weight: 700; }
  .panel.notyet li::before {
    content: ""; position: absolute; left: 2px; top: 11px; width: 11px; height: 11px;
    border: 1.5px solid var(--rule); border-radius: 50%;
  }
  .panel.notyet li { color: var(--ink-soft); }

  /* ---- 8. four calls to a receipt ---- */
  .path-wrap { display: flex; align-items: flex-start; gap: 20px; }
  .path-cap { width: 62px; flex: 0 0 62px; margin-top: 2px; filter: drop-shadow(0 8px 10px rgba(24, 34, 53, 0.12)); }
  .path { position: relative; display: grid; grid-template-columns: repeat(4, 1fr); gap: 22px; flex: 1; counter-reset: pstep; }
  .path::before { content: ""; position: absolute; left: 12px; right: 12px; top: 15px; height: 2px; background: var(--ledger); opacity: 0.45; }
  .pstep { position: relative; z-index: 1; padding-top: 44px; }
  .pstep::before {
    counter-increment: pstep; content: counter(pstep);
    position: absolute; top: 0; left: 0;
    font-family: var(--mono); font-size: 13px; color: #fff; background: var(--ledger);
    width: 30px; height: 30px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
  }
  .pstep b { font-weight: 600; font-size: 15.5px; }
  .pstep code { font-size: 12.5px; background: var(--chip); padding: 1px 6px; border-radius: 2px; }
  .pstep p { color: var(--ink-soft); font-size: 13.5px; margin-top: 5px; }

  /* ---- 9. CTA + meadow + footer bar ---- */
  .cta { text-align: center; padding-block: clamp(72px, 8vw, 110px) 0; }
  .cta h2 { font-size: clamp(30px, 4vw, 46px); font-weight: 600; letter-spacing: -0.012em; }
  .cta p { margin-top: 12px; color: var(--ink-soft); font-size: 17px; }
  .cta-btns { display: flex; gap: 14px; justify-content: center; flex-wrap: wrap; margin-top: 30px; }
  .cta .run { max-width: 760px; margin: 34px auto 0; text-align: left; font-size: 13px; }

  /* One bespoke full-width scene: plaque, lake village, cat, signpost. Its
     transparent sky lets the paper show above the treeline, and its dirt
     path bottoms out flush against the dark footer bar. */
  .meadow { margin-top: 56px; }
  .meadow-img { display: block; width: 100%; }

  .foot-bar { background: var(--terminal); color: #aab4c5; padding: 30px 0 38px; font-size: 13.5px; }
  .foot-bar .fence { font-style: italic; font-size: 15.5px; color: #f2f0e8; max-width: 34em; }
  .foot-bar a { color: #7fc7ad; }
  .foot-bar .cols { display: flex; justify-content: space-between; gap: 28px; flex-wrap: wrap; margin-top: 18px; }
  .foot-bar .mono { font-size: 12px; line-height: 2; }

  /* ---- motion: one entrance, small loops, then stillness ---- */
  @media (prefers-reduced-motion: no-preference) {
    .rise { opacity: 0; transform: translateY(14px); animation: rise 0.55s ease-out forwards; }
    .rise.d1 { animation-delay: 0.08s; } .rise.d2 { animation-delay: 0.18s; }
    .rise.d3 { animation-delay: 0.28s; } .rise.d4 { animation-delay: 0.42s; }
    @keyframes rise { to { opacity: 1; transform: none; } }
    .toast { opacity: 0; animation: toast-in 0.5s ease-out forwards, bob 5.5s ease-in-out infinite alternate; }
    .toast.t1 { animation-delay: 0.7s, 1.2s; }
    .toast.t2 { animation-delay: 1.05s, 1.55s; }
    .toast.t3 { animation-delay: 1.4s, 1.9s; }
    @keyframes toast-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
    @keyframes bob { from { translate: 0 0; } to { translate: 0 -6px; } }
    .sl-token, .band-token, .path-cap { animation: bob 4.5s ease-in-out infinite alternate; }
    .js .stamp-img, .js .vs-stamp { opacity: 0; }
    .js .stamp-img.stamped, .js .vs-stamp.stamped { animation: stamp 0.4s cubic-bezier(0.2, 1.4, 0.4, 1) 0.15s forwards; }
    @keyframes stamp { from { opacity: 0; transform: scale(1.6) rotate(2deg); } to { opacity: 1; transform: none; } }
    .rail::after { transform: scaleX(0); animation: draw 1.1s ease-out 0.3s forwards; }
    @keyframes draw { to { transform: scaleX(1); } }
    .cur { animation: blink 1.1s steps(1) infinite; }
    @keyframes blink { 50% { opacity: 0; } }
  }

  /* A grid track's minimum is its content's min-content width, and a terminal
     block with one long line is exactly that — on a phone it pushed every
     sibling in the column to 629px and the page scrolled sideways. */
  .verify-grid > *, .evi-grid > *, .breaks > *, .cat-grid > *, .status-grid > * { min-width: 0; }
  .term { overflow-x: auto; max-width: 100%; }

  /* ---- responsive ---- */
  @media (max-height: 720px) {
    .stage { min-height: 800px; }
    .stage-copy { top: 12%; }
    .toasts { top: 10.5%; }
  }
  @media (max-width: 1080px) {
    .cat-gate { width: 92px; top: -34px; right: -14px; }
    .evi-grid { gap: 32px; }
    .stilllife { min-height: 320px; }
    .sl-ledger { width: 210px; } .sl-lock { width: 170px; } .sl-token { width: 125px; }
  }
  @media (max-width: 960px) {
    .stage-copy { top: 17%; }
    .stage-nav .wordmark small { display: none; }
    .cat-grid { grid-template-columns: 1fr; }
    .cat-arrow { transform: rotate(90deg); justify-self: center; }
    .evi-grid { grid-template-columns: 1fr; }
    .stilllife { order: 2; min-height: 300px; max-width: 480px; }
    .traits { grid-template-columns: 1fr; gap: 16px; }
    .rail { flex-direction: column; padding-left: 26px; }
    .rail::before, .rail::after { left: 8px; right: auto; top: 0; bottom: 0; width: 2px; height: auto; }
    .rail::after { transform-origin: center top; }
    .breaks { grid-template-columns: 1fr; }
    .verify-grid { grid-template-columns: 1fr; }
    .status-grid { grid-template-columns: 1fr; }
    .path-wrap { flex-direction: column; }
    .path-cap { display: none; }
    .path { grid-template-columns: 1fr; gap: 16px; }
    .path::before { left: 15px; right: auto; top: 12px; bottom: 12px; width: 2px; height: auto; }
    .pstep { padding-top: 0; padding-left: 48px; }
    .score th { width: 120px; white-space: normal; }
  }
  @media (max-width: 620px) {
    .stage-nav { flex-wrap: wrap; row-gap: 10px; padding: 16px 20px; }
    .stage-nav nav { margin-left: auto; }
    .stage-nav nav a:nth-child(2) { display: none; }
    .stage-copy { top: 24%; }
    .stage-copy .sub { font-size: 16.5px; }
    .stage-tint {
      background: linear-gradient(to bottom, rgba(8, 22, 36, 0.52), rgba(8, 22, 36, 0.3) 55%, rgba(8, 22, 36, 0.12));
    }
    .stamp-img { width: 150px; right: 0; }
    /* The gate art overlapped the card's label at phone widths. */
    .cat-gate { width: 74px; top: -28px; right: -10px; }
    .cat-main .role { padding-right: 70px; }
  }
  @media (max-width: 900px) { .toasts { display: none; } }
`;
