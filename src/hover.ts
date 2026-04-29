import { Page } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { HoverState, SectionInfo } from './types.ts';

// Visit each interactive (cursor:pointer) element per section, hover it,
// diff its computed style. Output is a per-section list of "this thing
// changes from X→Y on hover with this transition" — exactly the recipe
// the rebuild needs to feel framer-tier.
//
// We cap to a small number per section to keep runtime bounded; framer
// pages typically have 3-8 hover-able elements per section that matter.

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

export async function captureHoverStates(
  page: Page,
  sections: SectionInfo[],
  perSectionCap = 6
): Promise<HoverState[]> {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);

  const out: HoverState[] = [];

  for (const section of sections) {
    // Collect candidate selectors inside this section: cursor:pointer +
    // one of (button, a, [role=button]) — we want the most "hoverable" things.
    const candidates = await page.evaluate(
      ({ sectionSelector, cap, props }) => {
        const root = document.querySelector(sectionSelector);
        if (!root) return [];
        const seen = new Set<Element>();
        const cands: Element[] = [];
        const add = (e: Element) => {
          if (!seen.has(e)) { seen.add(e); cands.push(e); }
        };
        // Buttons + links first
        root.querySelectorAll('button, a, [role="button"]').forEach((e) => add(e));
        // Then anything with cursor:pointer
        if (cands.length < cap) {
          root.querySelectorAll<HTMLElement>('*').forEach((e) => {
            if (cands.length >= cap * 4) return;
            const cs = getComputedStyle(e);
            if (cs.cursor === 'pointer') add(e);
          });
        }

        // Build stable selectors + initial computed-style snapshot
        function cssEsc(s: string) { return (window as any).CSS?.escape ? (window as any).CSS.escape(s) : s; }
        function selFor(el: Element) {
          if (el.id) return `#${cssEsc(el.id)}`;
          const path: string[] = [];
          let n: Element | null = el;
          while (n && n !== document.body && path.length < 6) {
            let part = n.tagName.toLowerCase();
            const cls = (n as HTMLElement).className && typeof (n as HTMLElement).className === 'string'
              ? (n as HTMLElement).className.trim().split(/\s+/).slice(0, 2).filter(Boolean).join('.')
              : '';
            if (cls) part += '.' + cls;
            const parent = n.parentElement;
            if (parent) {
              const idx = Array.from(parent.children).indexOf(n) + 1;
              part += `:nth-child(${idx})`;
            }
            path.unshift(part);
            n = n.parentElement;
          }
          return path.join(' > ');
        }
        const result: any[] = [];
        for (const el of cands.slice(0, cap)) {
          const r = el.getBoundingClientRect();
          if (r.width < 4 || r.height < 4) continue;
          const cs = getComputedStyle(el);
          const before: Record<string, string> = {};
          for (const p of props) before[p] = (cs as any)[p];
          // Tag for stable mid-pass lookup
          const id = `__esi-${result.length}-${Math.random().toString(36).slice(2, 8)}`;
          (el as HTMLElement).dataset.esiHover = id;
          result.push({
            selector: selFor(el),
            framerName: (el as HTMLElement).dataset.framerName,
            text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
            bbox: {
              x: Math.round(r.left + window.scrollX),
              y: Math.round(r.top + window.scrollY),
              w: Math.round(r.width),
              h: Math.round(r.height),
            },
            transition: cs.transition && cs.transition !== 'all 0s ease 0s' ? cs.transition : undefined,
            duration: cs.transitionDuration,
            easing: cs.transitionTimingFunction,
            before,
            esiId: id,
          });
        }
        return result;
      },
      { sectionSelector: section.selector, cap: perSectionCap, props: TRACKED_PROPS }
    );

    for (const c of candidates) {
      // Hover via dataset attribute we just added; fall back to selector.
      const handle = await page.$(`[data-esi-hover="${c.esiId}"]`);
      if (!handle) continue;
      try {
        await handle.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
        await handle.hover({ force: true, timeout: 2000 });
        await page.waitForTimeout(420); // wait out the typical 200-400ms transition
      } catch {
        await handle.dispose();
        continue;
      }
      const after: Record<string, string> | null = await page.evaluate(
        ({ esiId, props }) => {
          const el = document.querySelector(`[data-esi-hover="${esiId}"]`);
          if (!el) return null;
          const cs = getComputedStyle(el);
          const out: Record<string, string> = {};
          for (const p of props) out[p] = (cs as any)[p];
          return out;
        },
        { esiId: c.esiId, props: TRACKED_PROPS }
      );
      // Move mouse away to reset
      await page.mouse.move(0, 0).catch(() => {});
      await handle.dispose();

      if (!after) continue;
      const delta: Record<string, { from: string; to: string }> = {};
      for (const p of TRACKED_PROPS) {
        if (c.before[p] !== after[p]) delta[p] = { from: c.before[p], to: after[p] };
      }
      if (Object.keys(delta).length === 0) continue; // no visible hover

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

  // Cleanup tags
  await page.evaluate(() => {
    document.querySelectorAll('[data-esi-hover]').forEach((el) => {
      delete (el as HTMLElement).dataset.esiHover;
    });
    window.scrollTo(0, 0);
  });

  return out;
}

export async function writeHoverArtifacts(outDir: string, hovers: HoverState[]) {
  await mkdir(join(outDir, 'motion'), { recursive: true });
  await writeFile(join(outDir, 'motion', 'hover.json'), JSON.stringify(hovers, null, 2), 'utf8');
  console.log(`  🖱  ${hovers.length} hover states captured (cursor:pointer + buttons/links)`);
}
