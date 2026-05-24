// hover-fiber.ts — read framer's `whileHover` props directly out of React
// fibers, no mouse simulation. framer sites are React + framer-motion
// apps; every motion component carries `whileHover` (and friends) on its
// fiber's memoizedProps. we walk the fiber tree, find every node with
// hover-related props, and record (cs-id of dom element, whileHover spec,
// transition spec).
//
// this is far better than mouse-driven capture because:
//   - no false negatives from elements off-screen / behind cap limits
//   - no flakiness from animation-in-progress timing
//   - we get the EXACT framer-motion spec (scale, x, y, color, transition)
//     in its declarative form, not a delta of computed styles
//
// works on framer-built sites (uses framer-motion under the hood).

import { Page } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface FiberHoverSpec {
  csId: string | null;
  framerName: string | null;
  tag: string;
  // The whileHover prop value, normalized to plain object
  whileHover: Record<string, any>;
  // Transition spec from props.transition (duration, ease, type, etc.)
  transition?: Record<string, any>;
  // Initial state (props.initial) for context — what the resting state looks like
  initial?: Record<string, any>;
}

export async function captureFiberHovers(page: Page): Promise<FiberHoverSpec[]> {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);

  const specs: FiberHoverSpec[] = await page.evaluate(() => {
    const out: any[] = [];

    function getFiber(el: Element): any {
      for (const k in el) {
        if (k.startsWith('__reactFiber$')) return (el as any)[k];
      }
      return null;
    }

    // walk every visible element with a fiber, look at its props (and a few
    // ancestors in the fiber tree — framer wraps motion components inside
    // forwardRef/memo so the whileHover prop may be on a parent fiber).
    function findHoverProps(fiber: any, depth = 0): any | null {
      let cur = fiber;
      let steps = 0;
      while (cur && steps < 6) {
        const props = cur.memoizedProps ?? cur.pendingProps;
        if (props && typeof props === 'object') {
          if (props.whileHover && typeof props.whileHover === 'object') {
            return {
              whileHover: props.whileHover,
              transition: props.transition,
              initial: props.initial,
            };
          }
          // framer-motion sometimes uses `animate` + `variants` keyed on hover,
          // or wraps in a HoverTrigger HOC. catch the common case for now.
        }
        cur = cur.return;
        steps++;
      }
      return null;
    }

    document.querySelectorAll<HTMLElement>('[data-cs-id]').forEach((el) => {
      const fiber = getFiber(el);
      if (!fiber) return;
      const hit = findHoverProps(fiber);
      if (!hit) return;
      // serialize whileHover to a plain object (drop functions / refs)
      const safe = (v: any): any => {
        if (v == null) return v;
        if (typeof v === 'function') return undefined;
        if (typeof v !== 'object') return v;
        if (Array.isArray(v)) return v.map(safe).filter((x) => x !== undefined);
        const o: any = {};
        for (const k of Object.keys(v)) {
          const sv = safe(v[k]);
          if (sv !== undefined) o[k] = sv;
        }
        return o;
      };
      out.push({
        csId: el.dataset.csId ?? null,
        framerName: el.dataset.framerName ?? null,
        tag: el.tagName.toLowerCase(),
        whileHover: safe(hit.whileHover),
        transition: hit.transition ? safe(hit.transition) : undefined,
        initial: hit.initial ? safe(hit.initial) : undefined,
      });
    });

    return out;
  });

  return specs;
}

export async function writeFiberHoverArtifacts(outDir: string, specs: FiberHoverSpec[]) {
  await mkdir(join(outDir, 'motion'), { recursive: true });
  await writeFile(
    join(outDir, 'motion', 'hover-fiber.json'),
    JSON.stringify(specs, null, 2),
    'utf8',
  );
  console.log(`  🪝 hover-fiber.json (${specs.length} React-fiber whileHover spec(s))`);
}
