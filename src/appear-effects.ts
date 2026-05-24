// appear-effects.ts — capture framer's appear-effect specs BEFORE framer's
// runtime animates them away.
//
// the trick: framer injects a `<style data-framer-appear-css>` block at boot
// containing per-element initial states (opacity:0, transform:..). when an
// element scrolls into view, framer's runtime calls animate() and removes
// the matching rule. by the time we capture the dom, those rules are gone.
//
// fix: monkey-patch IntersectionObserver via addInitScript so it never fires
// callbacks. framer's runtime injects appear-css but never animates → the
// rules stay forever → we extract them.

import { Browser, BrowserContext, chromium } from "playwright";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface AppearEffect {
  id: string;                       // synthetic id (appear-N) for legacy reference
  csId: string | null;              // matches data-cs-id from computed-styles.ts (same DOM walk order)
  framerName: string | null;
  appearId: string | null;
  initial: Record<string, string>;  // parsed CSS declarations (opacity, transform, etc)
  rawStyle: string;                 // raw inline style for fingerprint matching fallback
}

export async function captureAppearEffects(
  url: string,
  outDir: string,
  opts: { headless?: boolean } = {},
): Promise<{ effects: AppearEffect[]; rawBlock: string | null }> {
  // dedicated browser so we can install init scripts without affecting the
  // main extract pass
  const browser: Browser = await chromium.launch({ headless: opts.headless ?? true });
  const context: BrowserContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });

  // disable IntersectionObserver callbacks AND the WAAPI animate() function.
  // framer's runtime needs both to drive its appear-effects; killing them
  // freezes the page in its initial-styles state, which is what we want.
  await context.addInitScript(() => {
    // never trigger IO callbacks → framer's appear scheduler waits forever
    const NoopIO = class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
    };
    (window as any).IntersectionObserver = NoopIO;
    // also short-circuit Element.animate so any direct calls become no-ops
    const noop = () => ({
      cancel: () => {},
      finish: () => {},
      pause: () => {},
      play: () => {},
      reverse: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      finished: Promise.resolve(),
    });
    Element.prototype.animate = noop as any;
  });

  const page = await context.newPage();
  await page.goto(url, { waitUntil: "networkidle", timeout: 60000 }).catch(async () => {
    await page.goto(url, { waitUntil: "load", timeout: 60000 });
  });
  // give framer's chunk plenty of time to inject the appear-css
  await page.waitForTimeout(2000);

  const result = await page.evaluate(() => {
    // STEP 1: tag every visible element with data-cs-id="N" using the SAME
    // depth-first walk + SKIP set as computed-styles.ts. since both passes
    // load the same URL with deterministic DOM, the cs-ids will line up.
    // this is what lets the rebuild runtime find these elements via
    // [data-cs-id="N"] selectors against the dom dump (which had cs-ids
    // applied by the main extract pass).
    const SKIP = new Set(["SCRIPT", "STYLE", "META", "LINK", "HEAD", "TITLE", "BR", "NOSCRIPT"]);
    let csCounter = 0;
    function tagWalk(el: Element) {
      if (SKIP.has(el.tagName)) return;
      el.setAttribute("data-cs-id", String(csCounter++));
      for (const child of Array.from(el.children)) tagWalk(child);
    }
    if (document.body) tagWalk(document.body);

    // STEP 2: framer encodes appear-effect initial state as INLINE styles on each
    // element (opacity:0.001, transform:translateY(120px), etc). walk every
    // element with [style] and capture appear-effect-shaped declarations.
    const effects: {
      id: string;
      csId: string | null;
      framerName: string | null;
      appearId: string | null;
      initial: Record<string, string>;
      rawStyle: string;
    }[] = [];

    let counter = 0;
    document.querySelectorAll<HTMLElement>("[style]").forEach((el) => {
      const style = el.getAttribute("style") ?? "";
      // signals: opacity below 0.5, will-change:transform with translate, scale<1
      const hasInitOpacity = /opacity\s*:\s*0(?:\.\d+)?(?!\d)/.test(style) && !/opacity\s*:\s*1\b/.test(style);
      const hasInitTransform = /transform\s*:[^;]*(translate|scale\s*\(0|rotate)/.test(style);
      if (!hasInitOpacity && !hasInitTransform) return;
      // skip elements that are obviously decorative (final transform, not initial)
      if (/opacity\s*:\s*(0\.[6-9]|1)/.test(style) && !hasInitTransform) return;

      const decls: Record<string, string> = {};
      for (const decl of style.split(";")) {
        const colon = decl.indexOf(":");
        if (colon < 0) continue;
        const prop = decl.slice(0, colon).trim();
        const val = decl.slice(colon + 1).trim();
        if (!prop || !val) continue;
        // only keep the props that drive entry animations
        if (/^(opacity|transform|filter|will-change)$/i.test(prop)) {
          decls[prop] = val;
        }
      }
      if (Object.keys(decls).length === 0) return;

      effects.push({
        id: `appear-${counter++}`,
        csId: el.getAttribute("data-cs-id"),  // populated by tagWalk above
        framerName: el.getAttribute("data-framer-name"),
        appearId: el.getAttribute("data-framer-appear-id"),
        initial: decls,
        rawStyle: style,
      });
    });

    return { effects, rawBlock: null };
  });

  await browser.close();

  await mkdir(join(outDir, "motion"), { recursive: true });
  await writeFile(
    join(outDir, "motion", "appear-effects.json"),
    JSON.stringify(result, null, 2),
    "utf8",
  );
  console.log(`  ✨ appear-effects.json (${result.effects.length} per-element specs captured)`);
  return result;
}
