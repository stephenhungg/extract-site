import { Page } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { HoverState, SectionInfo } from './types.ts';

// Hover-state capture, take 2.
//
// v0.4 used dataset markers to re-acquire elements after hovering. Framer's
// React reconciliation strips those attrs on rerender, so the second lookup
// returned 0 hits.
//
// v0.5 approach: get a stable selector + bbox per candidate, then drive
// hover via raw mouse coordinates (page.mouse.move to bbox center). The
// "after" snapshot is captured by re-querying the page with the same
// selector — if it survives, we record the delta; if not we skip (no fake
// data). Selectors are built from id, framer-name, or unique class chain.

const TRACKED_PROPS = [
  'color',
  'backgroundColor',
  'borderColor',
  'borderTopColor',
  'opacity',
  'transform',
  'boxShadow',
  'filter',
  'backdropFilter',
  'letterSpacing',
  'textDecoration',
  'borderRadius',
  'scale',
];

interface Candidate {
  selector: string;
  framerName?: string;
  text?: string;
  bbox: { x: number; y: number; w: number; h: number };
  before: Record<string, string>;
  transition?: string;
  duration?: string;
  easing?: string;
}

export async function captureHoverStates(
  page: Page,
  sections: SectionInfo[],
  perSectionCap = 5
): Promise<HoverState[]> {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);

  const out: HoverState[] = [];

  for (const section of sections) {
    const candidates: Candidate[] = await page.evaluate(
      ({ sectionSelector, cap, props }) => {
        const root = document.querySelector(sectionSelector);
        if (!root) return [];

        function bestSelector(el: Element): string | null {
          // Prefer id
          const id = (el as HTMLElement).id;
          if (id) {
            const sel = `#${(window as any).CSS?.escape ? (window as any).CSS.escape(id) : id}`;
            if (document.querySelectorAll(sel).length === 1) return sel;
          }
          // Try data-framer-name (often unique enough scoped to root)
          const fn = (el as HTMLElement).dataset?.framerName;
          if (fn) {
            const sel = `[data-framer-name="${fn.replace(/"/g, '\\"')}"]`;
            if (document.querySelectorAll(sel).length === 1) return sel;
          }
          // Build a chain from sectionSelector to el using nth-child
          const path: string[] = [];
          let n: Element | null = el;
          while (n && n !== root) {
            const parent = n.parentElement;
            if (!parent) break;
            const idx = Array.from(parent.children).indexOf(n) + 1;
            const tag = n.tagName.toLowerCase();
            path.unshift(`${tag}:nth-child(${idx})`);
            n = parent;
          }
          if (!path.length) return null;
          const sel = `${sectionSelector} > ${path.join(' > ')}`;
          // Validate uniqueness
          if (document.querySelectorAll(sel).length === 1) return sel;
          return null;
        }

        const seen = new Set<Element>();
        const list: Element[] = [];
        const add = (e: Element) => {
          if (!seen.has(e)) { seen.add(e); list.push(e); }
        };
        root.querySelectorAll('button, a, [role="button"]').forEach((e) => add(e));
        if (list.length < cap) {
          root.querySelectorAll('*').forEach((e) => {
            if (list.length >= cap * 4) return;
            const cs = getComputedStyle(e);
            if (cs.cursor === 'pointer') add(e);
          });
        }

        const result: any[] = [];
        for (const el of list) {
          if (result.length >= cap) break;
          const r = el.getBoundingClientRect();
          if (r.width < 8 || r.height < 8) continue;
          const sel = bestSelector(el);
          if (!sel) continue;
          const cs = getComputedStyle(el);
          const before: Record<string, string> = {};
          for (const p of props) before[p] = (cs as any)[p];
          // Note: we don't filter on "has transition declared" — framer-motion
          // adds transitions dynamically when whileHover triggers, so the
          // resting state often shows transition: none. We hover everything
          // and only record entries where the after-state actually differs.
          result.push({
            selector: sel,
            framerName: (el as HTMLElement).dataset?.framerName,
            text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
            bbox: {
              x: Math.round(r.left + window.scrollX),
              y: Math.round(r.top + window.scrollY),
              w: Math.round(r.width),
              h: Math.round(r.height),
            },
            before,
            transition: cs.transition,
            duration: cs.transitionDuration,
            easing: cs.transitionTimingFunction,
          });
        }
        return result;
      },
      { sectionSelector: section.selector, cap: perSectionCap, props: TRACKED_PROPS }
    );

    for (const c of candidates) {
      // Scroll element into view via JS (more reliable than playwright's hover scroll
      // because framer pages have lenis intercepts that fight playwright).
      await page.evaluate(({ y, h, vph }) => {
        const top = y - Math.max(0, (vph - h) / 2);
        window.scrollTo({ top: Math.max(0, top), behavior: 'instant' as ScrollBehavior });
      }, { y: c.bbox.y, h: c.bbox.h, vph: 900 });
      await page.waitForTimeout(250);

      // Mouse-move to viewport-coords center of the element.
      const cxCxCy = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
      }, c.selector);
      if (!cxCxCy) continue;
      await page.mouse.move(cxCxCy.cx, cxCxCy.cy, { steps: 4 });
      await page.waitForTimeout(450);

      const after: Record<string, string> | null = await page.evaluate(
        ({ sel, props }) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const cs = getComputedStyle(el);
          const out: Record<string, string> = {};
          for (const p of props) out[p] = (cs as any)[p];
          return out;
        },
        { sel: c.selector, props: TRACKED_PROPS }
      );
      // park the cursor off-screen so the next iteration starts clean
      await page.mouse.move(0, 0);
      await page.waitForTimeout(150);
      if (!after) continue;

      const delta: Record<string, { from: string; to: string }> = {};
      for (const p of TRACKED_PROPS) {
        if (c.before[p] !== after[p]) delta[p] = { from: c.before[p], to: after[p] };
      }
      if (Object.keys(delta).length === 0) continue;

      out.push({
        selector: c.selector,
        framerName: c.framerName,
        sectionSlug: section.slug,
        bbox: c.bbox,
        text: c.text || undefined,
        delta,
        transition: c.transition,
        duration: c.duration,
        easing: c.easing,
      });
    }
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  return out;
}

export async function writeHoverArtifacts(outDir: string, hovers: HoverState[]) {
  await mkdir(join(outDir, 'motion'), { recursive: true });
  await writeFile(join(outDir, 'motion', 'hover.json'), JSON.stringify(hovers, null, 2), 'utf8');
  console.log(`  🖱  ${hovers.length} hover states captured (selector + mouse coords)`);
}
