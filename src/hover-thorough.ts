// hover-thorough.ts — page-wide hover capture, cs-id keyed.
//
// the section-scoped + cap'd hover.ts misses hits because:
//   1. section selectors don't always match cleanly after layout/scroll
//   2. cap=N per section discards interactive elements past the limit
//   3. selector-path keys are brittle when framer rerenders
//
// this scanner:
//   - queries EVERY interactive element page-wide once
//   - uses data-cs-id as the durable identity (assigned in phase 3)
//   - mouse-moves to each candidate, waits 800ms (long enough for
//     framer-motion springs), captures subtree snapshot via cs-id
//   - records (triggerCsId, targetCsId, delta) for any descendant change
//
// the runtime then binds: on pointerenter of [data-cs-id="trigger"],
// animate [data-cs-id="target"] from delta.from → delta.to.

import { Page, BrowserContext } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const TRACKED_PROPS = [
  'transform', 'opacity', 'scale', 'boxShadow', 'filter', 'backdropFilter',
  'backgroundColor', 'color', 'borderColor', 'borderRadius',
  'letterSpacing', 'textDecoration',
];

export interface ThoroughHover {
  triggerCsId: string;       // element you point at
  triggerFramerName?: string;
  triggerTag: string;
  targetCsId: string;        // element that visually animates (often a descendant)
  targetFramerName?: string;
  delta: Record<string, { from: string; to: string }>;
  duration?: string;
  easing?: string;
}

/**
 * Hover capture via a dedicated isolated page, so we don't inherit any
 * mid-pipeline DOM/scroll state from prior extract phases. The main page
 * has been scrolled, scroll-motion sampled, layouts dumped — that state
 * tends to confuse cursor:pointer detection. A fresh load gives us the
 * raw DOM as users see it.
 */
export async function captureHoversThoroughIsolated(
  context: BrowserContext,
  url: string,
): Promise<ThoroughHover[]> {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch(async () => {
      await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    });
    await page.waitForTimeout(1500);
    return await captureHoversThorough(page);
  } finally {
    await page.close().catch(() => {});
  }
}

export async function captureHoversThorough(page: Page): Promise<ThoroughHover[]> {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);

  // 0. re-tag cs-ids: react rerenders between phase 3 (computed-styles)
  // and phase 9 (hover) strip data-cs-id from re-mounted elements. we
  // re-walk with the same depth-first order so ids align with phase 3.
  await page.evaluate(() => {
    const SKIP = new Set(['SCRIPT','STYLE','META','LINK','HEAD','TITLE','BR','NOSCRIPT']);
    let n = 0;
    function walk(el: Element) {
      if (SKIP.has(el.tagName)) return;
      el.setAttribute('data-cs-id', String(n++));
      for (const c of Array.from(el.children)) walk(c);
    }
    if (document.body) walk(document.body);
  });

  // 1. collect all candidate triggers page-wide.
  const triggers = await page.evaluate(({ props }) => {
    const seen = new Set<Element>();
    const out: Array<{
      csId: string;
      framerName?: string;
      tag: string;
      bbox: { x: number; y: number; w: number; h: number };
    }> = [];

    const add = (el: Element) => {
      if (seen.has(el)) return;
      const cid = (el as HTMLElement).dataset?.csId;
      if (!cid) return; // need cs-id for runtime addressability
      const r = el.getBoundingClientRect();
      // ignore truly invisible (0 size) but allow icons (down to 12x12)
      if (r.width < 12 || r.height < 12) return;
      seen.add(el);
      out.push({
        csId: cid,
        framerName: (el as HTMLElement).dataset?.framerName ?? undefined,
        tag: el.tagName.toLowerCase(),
        bbox: {
          x: Math.round(r.left + window.scrollX),
          y: Math.round(r.top + window.scrollY),
          w: Math.round(r.width),
          h: Math.round(r.height),
        },
      });
    };

    document.querySelectorAll('button, a, [role="button"]').forEach(add);
    document.querySelectorAll('*').forEach((el) => {
      if (out.length > 400) return;
      const cs = getComputedStyle(el);
      if (cs.cursor === 'pointer') add(el);
    });
    return out;
  }, { props: TRACKED_PROPS });

  console.log(`  [hover-thorough] ${triggers.length} candidate trigger(s)`);

  const out: ThoroughHover[] = [];
  let scanned = 0;

  for (const t of triggers) {
    scanned++;
    // scroll trigger into view (centered)
    await page.evaluate(({ y, h, vph }) => {
      const top = y - Math.max(0, (vph - h) / 2);
      window.scrollTo({ top: Math.max(0, top), behavior: 'instant' as ScrollBehavior });
    }, { y: t.bbox.y, h: t.bbox.h, vph: 900 });
    await page.waitForTimeout(150);

    // before snapshot: subtree by cs-id
    const beforeData = await page.evaluate(({ triggerCsId, props }) => {
      const el = document.querySelector(`[data-cs-id="${triggerCsId}"]`) as HTMLElement | null;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const subtree: Record<string, Record<string, string>> = {};
      const fnames: Record<string, string> = {};
      const walk = (n: Element, d: number) => {
        if (d > 6) return;
        const cid = (n as HTMLElement).dataset?.csId;
        if (cid) {
          const cs = getComputedStyle(n);
          const snap: Record<string, string> = {};
          for (const p of props) snap[p] = (cs as any)[p];
          subtree[cid] = snap;
          const fn = (n as HTMLElement).dataset?.framerName;
          if (fn) fnames[cid] = fn;
        }
        for (const c of Array.from(n.children)) walk(c, d + 1);
      };
      walk(el, 0);
      const cs = getComputedStyle(el);
      return {
        cx: r.left + r.width / 2,
        cy: r.top + r.height / 2,
        subtree,
        fnames,
        duration: cs.transitionDuration,
        easing: cs.transitionTimingFunction,
      };
    }, { triggerCsId: t.csId, props: TRACKED_PROPS });
    if (!beforeData) continue;

    // hover with steps so framer-motion's pointer detection registers
    await page.mouse.move(beforeData.cx, beforeData.cy, { steps: 12 });
    // 800ms covers most framer-motion springs (default ~600ms)
    await page.waitForTimeout(800);

    // after snapshot
    const afterSubtree = await page.evaluate(({ triggerCsId, props }) => {
      const el = document.querySelector(`[data-cs-id="${triggerCsId}"]`) as HTMLElement | null;
      if (!el) return null;
      const subtree: Record<string, Record<string, string>> = {};
      const walk = (n: Element, d: number) => {
        if (d > 6) return;
        const cid = (n as HTMLElement).dataset?.csId;
        if (cid) {
          const cs = getComputedStyle(n);
          const snap: Record<string, string> = {};
          for (const p of props) snap[p] = (cs as any)[p];
          subtree[cid] = snap;
        }
        for (const c of Array.from(n.children)) walk(c, d + 1);
      };
      walk(el, 0);
      return subtree;
    }, { triggerCsId: t.csId, props: TRACKED_PROPS });

    // unhover before next iteration
    await page.mouse.move(0, 0);
    await page.waitForTimeout(120);

    if (!afterSubtree) continue;

    // diff per descendant cs-id
    for (const [cid, beforeSnap] of Object.entries(beforeData.subtree)) {
      const afterSnap = afterSubtree[cid];
      if (!afterSnap) continue;
      const delta: Record<string, { from: string; to: string }> = {};
      for (const p of TRACKED_PROPS) {
        if (beforeSnap[p] !== afterSnap[p]) {
          delta[p] = { from: beforeSnap[p], to: afterSnap[p] };
        }
      }
      if (Object.keys(delta).length === 0) continue;
      out.push({
        triggerCsId: t.csId,
        triggerFramerName: t.framerName,
        triggerTag: t.tag,
        targetCsId: cid,
        targetFramerName: beforeData.fnames[cid],
        delta,
        duration: beforeData.duration,
        easing: beforeData.easing,
      });
    }
  }

  console.log(`  [hover-thorough] scanned ${scanned}, captured ${out.length} hover effect(s)`);
  return out;
}

export async function writeThoroughHoverArtifacts(outDir: string, hovers: ThoroughHover[]) {
  await mkdir(join(outDir, 'motion'), { recursive: true });
  await writeFile(
    join(outDir, 'motion', 'hover-thorough.json'),
    JSON.stringify(hovers, null, 2),
    'utf8',
  );
  console.log(`  🪝 hover-thorough.json (${hovers.length} cs-id-keyed hover effect(s))`);
}
