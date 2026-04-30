import { Page } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SectionInfo } from './types.ts';

// SCROLL-LINKED MOTION CAPTURE
//
// The CDP Animation listener catches CSS/WAAPI animations that fire at
// discrete moments (entrance, hover, marquee). It does NOT catch
// continuously scroll-driven motion — like the framer hero that shrinks
// + pins in the center as you scroll, or background parallax layers.
// Those are JS-driven `transform` updates (lenis + framer-motion's
// useScroll, or GSAP ScrollTrigger.scrub) that we never see in the
// Animation domain.
//
// This module samples every "interesting" element's bbox + transform +
// opacity at N scroll positions, then classifies each element's behavior
// as one of: normal flow, pinned (sticky-following-scroll), parallax,
// scroll-scaled, scroll-faded, pin-scrub (the hero pattern).

export type ScrollBehaviorKind =
  | 'pinned'           // element stays at fixed viewport position as scroll progresses
  | 'parallax'         // element moves slower than scroll
  | 'scroll-scaled'    // transform scale changes with scroll
  | 'scroll-translated'// transform translate changes with scroll (independent of normal flow)
  | 'scroll-faded'     // opacity changes with scroll position
  | 'pin-scrub'        // pinned AND has transform delta (the hero shrink pattern)
  | 'scroll-rotated';

export interface ScrollBehavior {
  selector: string;
  framerName?: string;
  tag: string;
  kind: ScrollBehaviorKind[];
  // The scroll range over which this behavior is active
  scrollFrom: number;
  scrollTo: number;
  // viewport-y trajectory: if vpTop stays roughly constant while scrollY changes,
  // element is pinned. slope is dVpTop/dScrollY.
  vpTopSlope: number;
  // Transform delta — the visible change
  scaleStart?: number;
  scaleEnd?: number;
  translateXStart?: number;
  translateXEnd?: number;
  translateYStart?: number;
  translateYEnd?: number;
  rotateStart?: number;
  rotateEnd?: number;
  opacityStart?: number;
  opacityEnd?: number;
  // bbox at first and last sample
  bboxStart: { x: number; y: number; w: number; h: number };
  bboxEnd: { x: number; y: number; w: number; h: number };
  text?: string;
  sectionSlug?: string;
}

interface RawSample {
  scrollY: number;
  elements: Array<{
    sel: string;
    framerName?: string;
    tag: string;
    text?: string;
    vpTop: number;
    vpLeft: number;
    width: number;
    height: number;
    docTop: number;
    transform: string;
    opacity: string;
  }>;
}

export async function captureScrollLinkedMotion(
  page: Page,
  sections: SectionInfo[]
): Promise<{ behaviors: ScrollBehavior[]; sectionBgColors: Map<string, string> }> {
  // 1. Tag interesting elements with stable ids, return their selectors.
  const candidateSelectors: string[] = await page.evaluate(() => {
    const out: string[] = [];
    let n = 0;
    const seen = new Set<Element>();
    const add = (el: Element) => {
      if (seen.has(el)) return;
      const r = el.getBoundingClientRect();
      // Ignore tiny + offscreen/zero — typical hidden helpers.
      if (r.width < 40 || r.height < 40) return;
      seen.add(el);
      const id = `__esi-sm-${n++}`;
      (el as HTMLElement).dataset.esiSm = id;
      out.push(`[data-esi-sm="${id}"]`);
    };
    // Tag every framer-named element (these are the "story beats" of the page)
    document.querySelectorAll('[data-framer-name]').forEach(add);
    // Plus sections, h1/h2, large images/videos, anything with sticky position.
    document.querySelectorAll('section, header, nav, footer, h1, h2, picture, video, img').forEach(add);
    document.querySelectorAll('*').forEach((el) => {
      if (out.length > 600) return;
      const cs = getComputedStyle(el);
      if (cs.position === 'sticky' || cs.position === 'fixed') add(el);
    });
    return out;
  });

  // 2. Sample at strided scroll positions across the document.
  const { totalH, vpH } = await page.evaluate(() => ({
    totalH: document.documentElement.scrollHeight,
    vpH: window.innerHeight,
  }));
  const stride = Math.max(200, Math.round(vpH / 3));
  const positions = new Set<number>();
  for (let y = 0; y <= totalH; y += stride) positions.add(y);
  positions.add(Math.max(0, totalH - vpH));
  // Densify around section boundaries — that's where transition choreography
  // lives (bg crossfade, pin handoff, headline exit/enter etc).
  for (const s of sections) {
    const top = s.bbox.y;
    for (const offset of [-vpH, -200, -50, 0, 50, 200, vpH * 0.5]) {
      const y = Math.max(0, Math.min(totalH, top + offset));
      positions.add(y);
    }
  }
  const sortedPositions = Array.from(positions).sort((a, b) => a - b);

  const samples: RawSample[] = [];
  for (const y of sortedPositions) {
    await page.evaluate((yy) => window.scrollTo(0, yy), y);
    await page.waitForTimeout(180);
    const elements: any[] = await page.evaluate((sels) => {
      return sels
        .map((sel: string) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return {
            sel,
            framerName: (el as HTMLElement).dataset?.framerName,
            tag: el.tagName.toLowerCase(),
            text: (el.textContent || '').trim().slice(0, 60) || undefined,
            vpTop: Math.round(r.top),
            vpLeft: Math.round(r.left),
            width: Math.round(r.width),
            height: Math.round(r.height),
            docTop: Math.round(r.top + window.scrollY),
            transform: cs.transform,
            opacity: cs.opacity,
          };
        })
        .filter(Boolean);
    }, candidateSelectors);
    samples.push({ scrollY: y, elements });
  }

  // 3. Capture per-section dominant bg color while we're at it.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);
  const sectionBg = await page.evaluate(
    (selectors) => {
      const out: { slug: string; bg: string }[] = [];
      for (const { slug, sel } of selectors) {
        const el = document.querySelector(sel);
        if (!el) continue;
        let bg = getComputedStyle(el).backgroundColor;
        // Walk up if transparent
        let n: Element | null = el;
        let depth = 0;
        while (
          (bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') &&
          n &&
          depth < 5
        ) {
          n = n.parentElement;
          if (n) bg = getComputedStyle(n).backgroundColor;
          depth++;
        }
        out.push({ slug, bg });
      }
      return out;
    },
    sections.map((s) => ({ slug: s.slug, sel: s.selector }))
  );
  const sectionBgColors = new Map<string, string>();
  for (const { slug, bg } of sectionBg) sectionBgColors.set(slug, bg);

  // 4. Cleanup tags
  await page.evaluate(() => {
    document.querySelectorAll('[data-esi-sm]').forEach((el) => {
      delete (el as HTMLElement).dataset.esiSm;
    });
    window.scrollTo(0, 0);
  });

  // 5. Classify behaviors
  const behaviors = classifyScrollBehaviors(samples, sections);
  return { behaviors, sectionBgColors };
}

function parseTransform(t: string): { scale: number; tx: number; ty: number; rotate: number } {
  // matrix(a, b, c, d, tx, ty) — scale = sqrt(a*a + b*b), rotate = atan2(b, a)
  if (!t || t === 'none') return { scale: 1, tx: 0, ty: 0, rotate: 0 };
  const m2 = t.match(/matrix\(([^)]+)\)/);
  if (m2) {
    const v = m2[1].split(',').map((x) => parseFloat(x.trim()));
    if (v.length >= 6) {
      const [a, b, , , tx, ty] = v;
      const scale = Math.sqrt(a * a + b * b);
      const rotate = (Math.atan2(b, a) * 180) / Math.PI;
      return { scale, tx, ty, rotate };
    }
  }
  const m3 = t.match(/matrix3d\(([^)]+)\)/);
  if (m3) {
    const v = m3[1].split(',').map((x) => parseFloat(x.trim()));
    if (v.length >= 16) {
      const [a, b, , , , e] = v;
      // scale = sqrt of (a*a + b*b)? matrix3d is more complex; just take scale from a if rotation negligible
      const scale = Math.sqrt(a * a + b * b);
      const tx = v[12], ty = v[13];
      const rotate = (Math.atan2(b, a) * 180) / Math.PI;
      return { scale, tx, ty, rotate };
    }
  }
  return { scale: 1, tx: 0, ty: 0, rotate: 0 };
}

function classifyScrollBehaviors(samples: RawSample[], sections: SectionInfo[]): ScrollBehavior[] {
  // Group samples by selector
  const bySel = new Map<string, Array<{ scrollY: number; e: RawSample['elements'][0] }>>();
  for (const s of samples) {
    for (const e of s.elements) {
      if (!bySel.has(e.sel)) bySel.set(e.sel, []);
      bySel.get(e.sel)!.push({ scrollY: s.scrollY, e });
    }
  }

  const out: ScrollBehavior[] = [];
  for (const [sel, snaps] of bySel) {
    if (snaps.length < 3) continue;
    const sortedByScroll = snaps.slice().sort((a, b) => a.scrollY - b.scrollY);

    // Filter to range where element is in/near viewport (avoids classifying
    // off-screen normal-flow elements as "scroll-translated" because docTop
    // never changes but vpTop does — that's just normal flow).
    const visible = sortedByScroll.filter((s) => {
      const e = s.e;
      // Within ±2 viewport heights of the scroll position
      return e.vpTop > -2000 && e.vpTop < 3000;
    });
    if (visible.length < 3) continue;

    // vpTop slope: -1 = normal flow, 0 = pinned, between = parallax
    const xs = visible.map((s) => s.scrollY);
    const ys = visible.map((s) => s.e.vpTop);
    const slope = linearSlope(xs, ys);

    const transforms = visible.map((s) => parseTransform(s.e.transform));
    const opacities = visible.map((s) => parseFloat(s.e.opacity));

    const scales = transforms.map((t) => t.scale);
    const txs = transforms.map((t) => t.tx);
    const tys = transforms.map((t) => t.ty);
    const rots = transforms.map((t) => t.rotate);

    const scaleRange = Math.max(...scales) - Math.min(...scales);
    const txRange = Math.max(...txs) - Math.min(...txs);
    const tyRange = Math.max(...tys) - Math.min(...tys);
    const rotRange = Math.max(...rots) - Math.min(...rots);
    const opRange = Math.max(...opacities) - Math.min(...opacities);

    const kinds: ScrollBehaviorKind[] = [];
    const isPinned = Math.abs(slope) < 0.08;
    const isParallax = slope > -0.92 && slope < -0.08;
    const hasScale = scaleRange > 0.05;
    const hasTx = txRange > 8;
    const hasTy = tyRange > 8;
    const hasRot = rotRange > 2;
    const hasOpacity = opRange > 0.1;

    if (isPinned && (hasScale || hasTx || hasTy || hasOpacity)) kinds.push('pin-scrub');
    else if (isPinned) kinds.push('pinned');
    else if (isParallax) kinds.push('parallax');
    if (hasScale && !kinds.includes('pin-scrub')) kinds.push('scroll-scaled');
    if ((hasTx || hasTy) && !kinds.includes('pin-scrub') && !kinds.includes('parallax')) {
      kinds.push('scroll-translated');
    }
    if (hasRot) kinds.push('scroll-rotated');
    if (hasOpacity && !kinds.includes('pin-scrub')) kinds.push('scroll-faded');

    if (!kinds.length) continue;

    // Find section by docTop
    const docTop = visible[0].e.docTop;
    const docCy = docTop + visible[0].e.height / 2;
    let bestSection: SectionInfo | undefined;
    let bestSize = Infinity;
    for (const s of sections) {
      const top = s.bbox.y;
      const bot = s.bbox.y + s.bbox.height;
      if (docCy < top || docCy > bot) continue;
      const sizeDelta = Math.abs(s.bbox.height - visible[0].e.height);
      if (sizeDelta < bestSize) {
        bestSize = sizeDelta;
        bestSection = s;
      }
    }

    out.push({
      selector: sel,
      framerName: visible[0].e.framerName,
      tag: visible[0].e.tag,
      kind: kinds,
      scrollFrom: visible[0].scrollY,
      scrollTo: visible[visible.length - 1].scrollY,
      vpTopSlope: Math.round(slope * 100) / 100,
      scaleStart: hasScale ? Math.round(scales[0] * 1000) / 1000 : undefined,
      scaleEnd: hasScale ? Math.round(scales[scales.length - 1] * 1000) / 1000 : undefined,
      translateXStart: hasTx ? Math.round(txs[0]) : undefined,
      translateXEnd: hasTx ? Math.round(txs[txs.length - 1]) : undefined,
      translateYStart: hasTy ? Math.round(tys[0]) : undefined,
      translateYEnd: hasTy ? Math.round(tys[tys.length - 1]) : undefined,
      rotateStart: hasRot ? Math.round(rots[0]) : undefined,
      rotateEnd: hasRot ? Math.round(rots[rots.length - 1]) : undefined,
      opacityStart: hasOpacity ? Math.round(opacities[0] * 100) / 100 : undefined,
      opacityEnd: hasOpacity ? Math.round(opacities[opacities.length - 1] * 100) / 100 : undefined,
      bboxStart: {
        x: visible[0].e.vpLeft,
        y: visible[0].e.docTop,
        w: visible[0].e.width,
        h: visible[0].e.height,
      },
      bboxEnd: {
        x: visible[visible.length - 1].e.vpLeft,
        y: visible[visible.length - 1].e.docTop,
        w: visible[visible.length - 1].e.width,
        h: visible[visible.length - 1].e.height,
      },
      text: visible[0].e.text,
      sectionSlug: bestSection?.slug,
    });
  }

  // Sort by impact: pin-scrub first, then large-scale, then others.
  out.sort((a, b) => {
    const score = (b: ScrollBehavior) => {
      let s = 0;
      if (b.kind.includes('pin-scrub')) s += 100;
      if (b.kind.includes('pinned')) s += 50;
      if (b.kind.includes('parallax')) s += 30;
      if (b.scaleStart && b.scaleEnd) s += Math.abs(b.scaleEnd - b.scaleStart) * 50;
      return s;
    };
    return score(b) - score(a);
  });
  return out;
}

function linearSlope(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const xMean = xs.reduce((a, b) => a + b, 0) / n;
  const yMean = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - xMean) * (ys[i] - yMean);
    den += (xs[i] - xMean) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

export async function writeScrollMotionArtifacts(
  outDir: string,
  behaviors: ScrollBehavior[],
  sectionBgColors: Map<string, string>
) {
  await mkdir(join(outDir, 'motion'), { recursive: true });
  await writeFile(
    join(outDir, 'motion', 'scroll-motion.json'),
    JSON.stringify({ behaviors, sectionBgColors: Object.fromEntries(sectionBgColors) }, null, 2),
    'utf8'
  );
  const counts = new Map<ScrollBehaviorKind, number>();
  for (const b of behaviors) for (const k of b.kind) counts.set(k, (counts.get(k) ?? 0) + 1);
  const summary = Array.from(counts.entries()).map(([k, n]) => `${k}=${n}`).join(' ');
  console.log(`  🌀 scroll-linked motion: ${behaviors.length} elements (${summary})`);
}
