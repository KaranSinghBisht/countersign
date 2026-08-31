/**
 * Binary assets for the landing page, loaded once at import time.
 *
 * The hero loop and the pixel-art accents live in the repo at assets/ and are
 * read relative to this module rather than the working directory, so
 * `make dev` (src/…) and a compiled `node dist/src/…` resolve the same files
 * no matter where the process was started from.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function assetRoots(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/http/pages → ../../../assets ; dist/src/http/pages → one level deeper.
  return [join(here, "../../../assets"), join(here, "../../../../assets")];
}

function load(name: string): Buffer {
  const candidates = assetRoots().map((root) => join(root, name));
  for (const path of candidates) {
    try {
      return readFileSync(path);
    } catch {
      // Not at this depth — try the next candidate; missing everywhere is a
      // hard error below, never a silently absent hero.
    }
  }
  throw new Error(`asset ${name} not found; looked in: ${candidates.join(", ")}`);
}

export const heroVideo = load("hero-video.mp4");
export const heroPoster = load("hero-poster.jpg");

const LANDING_TYPES: Record<string, string> = {
  png: "image/png",
  svg: "image/svg+xml",
};

/**
 * Pixel-art accents under assets/landing/, keyed by file name. Loaded as a
 * fixed allowlist at boot: the /assets/:name route can only ever serve what
 * this map holds, so a request path is a lookup key, never a file path.
 */
function loadLandingAssets(): Map<string, { data: Buffer; type: string }> {
  const out = new Map<string, { data: Buffer; type: string }>();
  for (const root of assetRoots()) {
    let names: string[];
    try {
      names = readdirSync(join(root, "landing"));
    } catch {
      continue;
    }
    for (const name of names) {
      const match = /^[a-z0-9-]+\.(png|svg)$/.exec(name);
      const type = match === null ? undefined : LANDING_TYPES[match[1] as string];
      if (type === undefined) continue;
      out.set(name, { data: readFileSync(join(root, "landing", name)), type });
    }
    if (out.size > 0) return out;
  }
  throw new Error(`assets/landing is missing or empty; looked in: ${assetRoots().join(", ")}`);
}

export const landingAssets = loadLandingAssets();
