import { Page, CDPSession } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AnimatedElement, AnimationKind, CDPAnimation, DetectedStack, SectionInfo } from './types.ts';

export async function detectStack(page: Page): Promise<DetectedStack> {
  return await page.evaluate(() => {
    const html = document.documentElement.outerHTML.slice(0, 200000);
    const scripts = Array.from(document.scripts)
      .map((s) => s.src + ' ' + (s.textContent || '').slice(0, 4000))
      .join('\n');
    const has = (re: RegExp) => re.test(html) || re.test(scripts);
    const stack: any = {
      framework: 'unknown',
      framerMotion: has(/framer-motion|motion-component|data-framer/i),
      framer: has(/framerusercontent\.com|framer\.com\/m\//i) || has(/data-framer-name/i),
      webflow: has(/webflow|w-nav|w-container/i),
      lenis: has(/lenis|smooth-scroll-content/i) || !!document.querySelector('html.lenis, .lenis'),
      gsap: has(/gsap|GreenSock|ScrollTrigger/i),
      three: has(/three\.js|three\.module|THREE\./i),
      splineRuntime: has(/splinetool|@splinetool\/runtime/i),
      notes: [] as string[],
    };
    if (has(/__NEXT_DATA__|_next\/static/i)) stack.framework = 'next';
    else if (has(/__SVELTEKIT_|sveltekit/i)) stack.framework = 'svelte';
    else if (has(/__nuxt|_nuxt\//i)) stack.framework = 'vue';
    else if (has(/react-dom|_reactRoot|data-reactroot/i)) stack.framework = 'react';
    if (stack.framer) stack.notes.push('Built with Framer (framer.com)');
    if (stack.lenis) stack.notes.push('Uses Lenis smooth scroll');
    if (stack.gsap) stack.notes.push('Uses GSAP');
    if (stack.framerMotion) stack.notes.push('Uses Framer Motion (motion library)');
    return stack;
  });
}

// Scan computed styles for any element with non-trivial transitions/animations.
export async function scanComputedTransitions(page: Page): Promise<AnimatedElement[]> {
  return await page.evaluate(() => {
    function selectorFor(el: Element): string {
      if (el.id) return `#${CSS.escape(el.id)}`;
      const path: string[] = [];
      let n: Element | null = el;
      while (n && n !== document.body && path.length < 6) {
        let part = n.tagName.toLowerCase();
        if ((n as HTMLElement).className && typeof (n as HTMLElement).className === 'string') {
          const cls = (n as HTMLElement).className.trim().split(/\s+/).slice(0, 2).join('.');
          if (cls) part += '.' + cls;
        }
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

    const out: any[] = [];
    const all = document.querySelectorAll('*');
    for (const el of Array.from(all)) {
      const cs = getComputedStyle(el);
      const trans = cs.transitionProperty;
      const anim = cs.animationName;
      const hasTrans = trans && trans !== 'none' && trans !== 'all 0s ease 0s';
      const hasAnim = anim && anim !== 'none';
      const hasFramerData = (el as HTMLElement).dataset && (
        Object.keys((el as HTMLElement).dataset).some((k) => k.startsWith('framer'))
      );
      if (!hasTrans && !hasAnim && !hasFramerData) continue;

      const text = (el.textContent || '').trim().slice(0, 60);
      const r = el.getBoundingClientRect();
      const bbox = {
        x: Math.round(r.left + window.scrollX),
        y: Math.round(r.top + window.scrollY),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
      out.push({
        selector: selectorFor(el),
        tag: el.tagName.toLowerCase(),
        classes: (el.className && typeof el.className === 'string'
          ? el.className.split(/\s+/).filter(Boolean)
          : []
        ).slice(0, 8),
        text: text || undefined,
        framerName: (el as HTMLElement).dataset?.framerName,
        bbox,
        cssTransition: hasTrans ? `${cs.transitionProperty} ${cs.transitionDuration} ${cs.transitionTimingFunction} ${cs.transitionDelay}` : undefined,
        cssAnimation: hasAnim ? `${cs.animationName} ${cs.animationDuration} ${cs.animationTimingFunction} ${cs.animationDelay}` : undefined,
        cssTransitionProperty: hasTrans ? cs.transitionProperty : undefined,
        cssTimingFunction: hasTrans ? cs.transitionTimingFunction : (hasAnim ? cs.animationTimingFunction : undefined),
        cssDuration: hasTrans ? cs.transitionDuration : (hasAnim ? cs.animationDuration : undefined),
        cssDelay: hasTrans ? cs.transitionDelay : (hasAnim ? cs.animationDelay : undefined),
        framerMotion: hasFramerData
          ? Object.fromEntries(
              Object.entries((el as HTMLElement).dataset).filter(([k]) => k.startsWith('framer'))
            )
          : undefined,
      });
      if (out.length > 1500) break;
    }
    return out;
  });
}

// Subscribe to Animation domain to capture every fired animation during a scroll-through.
// We grab backendNodeId so we can resolve each animation back to its DOM element after capture.
export async function captureCDPAnimations(
  cdp: CDPSession,
  page: Page,
  durationMs = 15000
): Promise<CDPAnimation[]> {
  const animations: CDPAnimation[] = [];
  await cdp.send('Animation.enable');
  cdp.on('Animation.animationStarted', (evt: any) => {
    try {
      const a = evt.animation;
      const src = a.source || {};
      animations.push({
        id: a.id,
        type: a.type,
        duration: src.duration ?? 0,
        delay: src.delay ?? 0,
        easing: src.easing ?? 'linear',
        iterations: src.iterations ?? 1,
        keyframes: src.keyframesRule?.keyframes?.map((k: any) => ({
          offset: parseFloat(k.offset ?? '0'),
          easing: k.easing,
          computedOffset: k.computedOffset,
        })),
        backendNodeId: src.backendNodeId,
      });
    } catch {}
  });

  // Trigger animations: scroll through, hover over interactive elements
  await page.evaluate(
    (durationMs) =>
      new Promise<void>((resolve) => {
        const start = Date.now();
        const id = setInterval(() => {
          window.scrollBy(0, 400);
          if (
            Date.now() - start > durationMs ||
            window.scrollY + window.innerHeight >= document.documentElement.scrollHeight
          ) {
            clearInterval(id);
            window.scrollTo(0, 0);
            setTimeout(resolve, 500);
          }
        }, 350);
      }),
    durationMs
  );

  await cdp.send('Animation.disable').catch(() => {});
  return animations;
}

// Resolve every CDP animation's backendNodeId to a real DOM element so we can
// recover bbox + framerName + tag. Done in one batched DOM.resolveNode pass
// rather than one per event (which would race the listener).
export async function resolveCDPAnimationNodes(
  cdp: CDPSession,
  animations: CDPAnimation[]
): Promise<CDPAnimation[]> {
  // Unique backend node ids
  const ids = Array.from(new Set(animations.map((a) => a.backendNodeId).filter((x): x is number => !!x)));
  if (!ids.length) return animations;

  const resolved = new Map<number, { bbox?: any; tag?: string; framerName?: string; text?: string }>();
  // Resolve in chunks; each resolveNode is one round-trip.
  for (const id of ids) {
    try {
      const r: any = await cdp.send('DOM.resolveNode', { backendNodeId: id });
      if (!r.object?.objectId) continue;
      const ev: any = await cdp.send('Runtime.callFunctionOn', {
        objectId: r.object.objectId,
        returnByValue: true,
        functionDeclaration: `function() {
          const r = this.getBoundingClientRect ? this.getBoundingClientRect() : null;
          const fr = this.dataset && this.dataset.framerName;
          const t = (this.textContent || '').trim().slice(0, 80);
          const tag = (this.tagName || '').toLowerCase();
          return {
            bbox: r ? { x: Math.round(r.left + window.scrollX), y: Math.round(r.top + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) } : null,
            tag, framerName: fr || undefined, text: t || undefined,
          };
        }`,
      });
      if (ev?.result?.value) resolved.set(id, ev.result.value);
      await cdp.send('Runtime.releaseObject', { objectId: r.object.objectId }).catch(() => {});
    } catch {
      // best effort — node may have been removed by the time we resolve.
    }
  }

  return animations.map((a) => {
    if (!a.backendNodeId) return a;
    const r = resolved.get(a.backendNodeId);
    if (!r) return a;
    return { ...a, bbox: r.bbox || undefined, tag: r.tag, framerName: r.framerName, text: r.text };
  });
}

// Bbox-containment: link animations to sections by point-in-bbox of the
// animated element's center. Falls back to "first section whose y-range
// contains the element top" for elements that overlap multiple sections.
export function linkAnimationsToSections<T extends { bbox?: { x: number; y: number; w: number; h: number } }>(
  animations: T[],
  sections: SectionInfo[]
): (T & { sectionSlug?: string; sectionIndex?: number })[] {
  return animations.map((a) => {
    if (!a.bbox) return a;
    const cy = a.bbox.y + a.bbox.h / 2;
    let best: SectionInfo | undefined;
    let bestScore = Infinity;
    for (const s of sections) {
      const sTop = s.bbox.y;
      const sBot = s.bbox.y + s.bbox.height;
      if (cy < sTop || cy > sBot) continue;
      // Prefer sections whose bbox is closest in size to the element's container
      const sizeDelta = Math.abs(s.bbox.height - a.bbox.h);
      if (sizeDelta < bestScore) {
        bestScore = sizeDelta;
        best = s;
      }
    }
    if (!best) {
      // fallback: section with closest y
      let minDist = Infinity;
      for (const s of sections) {
        const d = Math.abs(s.bbox.y + s.bbox.height / 2 - cy);
        if (d < minDist) {
          minDist = d;
          best = s;
        }
      }
    }
    return best ? { ...a, sectionSlug: best.slug, sectionIndex: best.index } : a;
  });
}

// Heuristic classifier — read the keyframes / css transition props and the
// element's framer attrs to tag what *kind* of animation this is. The point
// is to give the rebuild prompt a vocabulary the LLM can act on directly.
export function classifyAnimatedElement(a: AnimatedElement): AnimationKind[] {
  const kinds = new Set<AnimationKind>();
  const props = (a.cssTransitionProperty || '').toLowerCase();
  const trans = (a.cssTransition || a.cssAnimation || '').toLowerCase();
  const animName = (a.cssAnimation || '').toLowerCase();
  const framer = a.framerMotion || {};

  // Marquee detection — long linear infinite animations on a horizontal flex
  if (animName.includes('marquee') || animName.match(/scroll|slide|loop/) && trans.includes('linear') && trans.match(/[2-9]\ds|\d{3,}ms/)) {
    kinds.add('marquee');
  }
  // Hover-only — when transition is on common hover targets but no animation name fires on initial load
  if ((props.includes('all') || props.includes('color') || props.includes('background') || props.includes('opacity')) && !animName) {
    if (a.tag === 'a' || a.tag === 'button' || a.classes.some((c) => /btn|button|link|card/i.test(c))) {
      kinds.add('hover-only');
    }
  }
  // Framer-motion data attrs hint at viewport/scroll triggers
  if (framer.whileInView) kinds.add('fade'); // best guess; gets refined by CDP keyframes
  if (framer.whileHover) kinds.add('hover-only');
  if (framer.transition) kinds.add('fade');

  // Property-driven inference
  if (props.includes('opacity') || trans.includes('opacity')) kinds.add('fade');
  if (props.includes('transform') || trans.includes('transform')) {
    // We can't tell which transform without keyframes; mark as 'unclassified'
    // (gets refined below for CDP-linked elements).
    kinds.add('unclassified');
  }
  if (kinds.size === 0) kinds.add('unclassified');
  return Array.from(kinds);
}

// Detect CDP stagger groups: framer-motion fires WAAPI animations on each
// child, with stepped delays. Group by section + duration + easing, count
// members, infer step.
export function tagCDPStaggerGroups(animations: CDPAnimation[]): CDPAnimation[] {
  const groups = new Map<string, CDPAnimation[]>();
  for (const a of animations) {
    if (!a.bbox) continue;
    // Group by section + duration + easing — siblings in a stagger group all
    // share these. We use sectionSlug here because CDP doesn't give us a
    // parent selector we can rely on.
    const key = `${a.sectionSlug || '?'}|${a.duration}|${a.easing}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(a);
  }
  for (const [, arr] of groups) {
    if (arr.length < 3) continue;
    const sorted = arr.slice().sort((a, b) => a.delay - b.delay);
    const steps = sorted.slice(1).map((a, i) => a.delay - sorted[i].delay).filter((s) => s > 0);
    if (!steps.length) continue;
    const median = steps.sort((a, b) => a - b)[Math.floor(steps.length / 2)];
    if (median > 200) continue; // not a stagger if step > 200ms
    for (const a of arr) {
      a.classification = Array.from(new Set([...(a.classification || []), 'sibling-stagger' as AnimationKind]));
      // char-stagger if many short-text spans
      if (arr.length >= 8 && (a.tag === 'span' || a.tag === 'div') && a.text && a.text.length <= 3) {
        a.classification = Array.from(new Set([...(a.classification || []), 'char-stagger' as AnimationKind]));
      }
    }
  }
  return animations;
}

// Refine CDP animations: read keyframes to detect translate/scale/rotate/opacity deltas.
export function classifyCDPAnimation(a: CDPAnimation): AnimationKind[] {
  const kinds = new Set<AnimationKind>();
  // CDP keyframes only carry offsets/easings; the actual transform values aren't
  // exposed by Animation.animationStarted. So we infer from the duration + easing
  // shape and the source tag/framer name.
  if (a.duration > 5000 && a.iterations === Infinity) kinds.add('marquee');
  if (a.iterations === Infinity && a.duration <= 1500) kinds.add('scroll-linked');
  if (a.text?.toLowerCase().includes('marquee')) kinds.add('marquee');
  if (a.framerName?.toLowerCase().includes('marquee')) kinds.add('marquee');
  if (a.framerName?.toLowerCase().match(/parallax|sticky/)) kinds.add('parallax');
  if (a.duration >= 600 && a.duration <= 1500 && a.delay >= 0) kinds.add('fade'); // typical fade-in
  if (kinds.size === 0) kinds.add('unclassified');
  return Array.from(kinds);
}

// Detect sibling-stagger groups: same parent, same duration, monotonically
// increasing delay. Tag every member with 'sibling-stagger'.
export function tagStaggerGroups(animations: AnimatedElement[]): AnimatedElement[] {
  // Group by selector parent (last selector segment dropped) + duration + easing
  const groups = new Map<string, AnimatedElement[]>();
  for (const a of animations) {
    if (!a.cssDuration || !a.cssDelay) continue;
    const parentKey = a.selector.split(' > ').slice(0, -1).join(' > ') + '|' + a.cssDuration + '|' + a.cssTimingFunction;
    if (!groups.has(parentKey)) groups.set(parentKey, []);
    groups.get(parentKey)!.push(a);
  }
  for (const [, arr] of groups) {
    if (arr.length < 3) continue;
    const delays = arr.map((a) => parseFloat(a.cssDelay || '0'));
    const sorted = [...delays].sort((a, b) => a - b);
    const isStepped = sorted.every((v, i) => i === 0 || v - sorted[i - 1] > 0);
    if (!isStepped) continue;
    for (const a of arr) {
      a.classification = Array.from(new Set([...(a.classification || []), 'sibling-stagger' as AnimationKind]));
    }
  }
  return animations;
}

// Char-stagger detection: if a heading has many text nodes/spans as children
// each animating, mark the parent with 'char-stagger'. Done by selector pattern
// — many siblings with same parent and same duration.
// (Subset of sibling-stagger but worth its own tag because rebuild patterns differ.)
export function detectCharStagger(animations: AnimatedElement[]): AnimatedElement[] {
  const bySelectorPrefix = new Map<string, number>();
  for (const a of animations) {
    if (!a.classification?.includes('sibling-stagger')) continue;
    if (a.tag !== 'span' && a.tag !== 'div') continue;
    if (!a.text || a.text.length > 3) continue; // likely individual chars
    const prefix = a.selector.split(' > ').slice(0, -1).join(' > ');
    bySelectorPrefix.set(prefix, (bySelectorPrefix.get(prefix) ?? 0) + 1);
  }
  for (const a of animations) {
    const prefix = a.selector.split(' > ').slice(0, -1).join(' > ');
    if ((bySelectorPrefix.get(prefix) ?? 0) >= 5 && a.classification?.includes('sibling-stagger')) {
      a.classification = Array.from(new Set([...(a.classification || []), 'char-stagger' as AnimationKind]));
    }
  }
  return animations;
}

export async function recordScrollVideo(
  page: Page,
  outDir: string
): Promise<string | null> {
  // Playwright's per-context recording is set when launching, but we can use
  // CDP screencast instead. Simpler: re-launch with recordVideo per-extraction.
  // For v0.1, skip — leave a placeholder. The static + animation data is enough.
  return null;
}

// Per-section motion summary — the "actionable" output for REBUILD.md.
export interface SectionMotionSummary {
  slug: string;
  framerName?: string;
  totalAnimated: number;
  cdpFired: number;
  hasParallax: boolean;
  hasMarquee: boolean;
  hasCharStagger: boolean;
  hasViewportFade: boolean;
  staggerGroups: { count: number; durationMs: number; delayStepMs: number; easing: string }[];
  dominantEasing?: string;
  dominantDurationMs?: number;
  notable: string[]; // human-readable lines: "h1 char-stagger 47ch × 18ms × 1000ms"
}

export function summarizeSectionMotion(
  sections: SectionInfo[],
  computed: AnimatedElement[],
  cdp: CDPAnimation[],
  hovers: { sectionSlug?: string; selector: string; framerName?: string; text?: string; delta: any; duration?: string; easing?: string }[]
): SectionMotionSummary[] {
  return sections.map((s) => {
    const inSection = computed.filter((a) => a.sectionSlug === s.slug);
    const cdpInSection = cdp.filter((a) => a.sectionSlug === s.slug);
    const hoversInSection = hovers.filter((h) => h.sectionSlug === s.slug);

    // dominant easing / duration in this section
    const easings = new Map<string, number>();
    const durations = new Map<number, number>();
    for (const a of inSection) {
      if (a.cssTimingFunction) easings.set(a.cssTimingFunction, (easings.get(a.cssTimingFunction) ?? 0) + 1);
      if (a.cssDuration) {
        const ms = parseDurationMs(a.cssDuration);
        if (ms) durations.set(ms, (durations.get(ms) ?? 0) + 1);
      }
    }
    for (const a of cdpInSection) {
      easings.set(a.easing, (easings.get(a.easing) ?? 0) + 1);
      durations.set(a.duration, (durations.get(a.duration) ?? 0) + 1);
    }
    const dominantEasing = topKey(easings);
    const dominantDurationMs = topKey(durations);

    const hasMarquee = inSection.some((a) => a.classification?.includes('marquee')) ||
      cdpInSection.some((a) => a.classification?.includes('marquee'));
    const hasCharStagger = inSection.some((a) => a.classification?.includes('char-stagger')) ||
      cdpInSection.some((a) => a.classification?.includes('char-stagger'));
    const hasSiblingStagger = inSection.some((a) => a.classification?.includes('sibling-stagger')) ||
      cdpInSection.some((a) => a.classification?.includes('sibling-stagger'));
    const sFramer = (s as any).framer || (s as any).framerName || '';
    const hasParallax = cdpInSection.some((a) => a.classification?.includes('parallax')) ||
      (typeof sFramer === 'string' && sFramer.toLowerCase().includes('hero') && cdpInSection.some((a) => a.iterations === Infinity));
    const hasViewportFade = inSection.some((a) => a.framerMotion?.whileInView) ||
      cdpInSection.some((a) => a.duration >= 600 && a.duration <= 1500 && a.delay >= 0);

    // stagger groups: cluster by duration+easing, count members, infer step
    const staggerGroups: any[] = [];
    const groupKey = (a: AnimatedElement) => `${a.cssDuration}|${a.cssTimingFunction}`;
    const grouped = new Map<string, AnimatedElement[]>();
    for (const a of inSection) {
      if (!a.classification?.includes('sibling-stagger')) continue;
      const k = groupKey(a);
      if (!grouped.has(k)) grouped.set(k, []);
      grouped.get(k)!.push(a);
    }
    for (const [, arr] of grouped) {
      if (arr.length < 3) continue;
      const delays = arr.map((a) => parseDurationMs(a.cssDelay || '0') || 0).sort((a, b) => a - b);
      const steps = delays.slice(1).map((d, i) => d - delays[i]).filter((s) => s > 0);
      const median = steps.length ? steps.sort((a, b) => a - b)[Math.floor(steps.length / 2)] : 0;
      staggerGroups.push({
        count: arr.length,
        durationMs: parseDurationMs(arr[0].cssDuration || '0') || 0,
        delayStepMs: median,
        easing: arr[0].cssTimingFunction || 'ease',
      });
    }
    // Also build groups from CDP staggers (framer-motion WAAPI)
    const cdpGrouped = new Map<string, CDPAnimation[]>();
    for (const a of cdpInSection) {
      if (!a.classification?.includes('sibling-stagger')) continue;
      const k = `${a.duration}|${a.easing}`;
      if (!cdpGrouped.has(k)) cdpGrouped.set(k, []);
      cdpGrouped.get(k)!.push(a);
    }
    for (const [, arr] of cdpGrouped) {
      if (arr.length < 3) continue;
      const sorted = arr.slice().sort((a, b) => a.delay - b.delay);
      const steps = sorted.slice(1).map((a, i) => a.delay - sorted[i].delay).filter((s) => s > 0);
      const median = steps.length ? steps.sort((a, b) => a - b)[Math.floor(steps.length / 2)] : 0;
      staggerGroups.push({
        count: arr.length,
        durationMs: arr[0].duration,
        delayStepMs: median,
        easing: arr[0].easing,
      });
    }

    const notable: string[] = [];
    if (hasParallax) notable.push('hero-style background parallax candidate (long-duration scroll-linked animation)');
    if (hasMarquee) notable.push('horizontal marquee loop — `linear` easing on a translateX, infinite iterations');
    if (hasCharStagger) {
      const grp = staggerGroups.find((g) => g.count > 8);
      if (grp) notable.push(`heading char-stagger: ~${grp.count} chars, ${grp.delayStepMs}ms step, ${grp.durationMs}ms each, easing \`${grp.easing}\``);
      else notable.push('heading char/word stagger detected (≥5 child spans with monotonic delays)');
    }
    for (const sg of staggerGroups.filter((g) => !g.count || g.count <= 8)) {
      notable.push(`stagger group: ${sg.count} items, ${sg.delayStepMs}ms step, ${sg.durationMs}ms each, easing \`${sg.easing}\``);
    }
    if (hasViewportFade && !hasCharStagger && !staggerGroups.length) {
      notable.push(`section enters on scroll: fade-up, ~${dominantDurationMs ?? 1000}ms, easing \`${dominantEasing ?? 'cubic-bezier(0.48, 0, 0.17, 0.96)'}\``);
    }
    if (hoversInSection.length) {
      const props = new Set<string>();
      for (const h of hoversInSection) for (const k of Object.keys(h.delta)) props.add(k);
      notable.push(`${hoversInSection.length} hover state(s): ${Array.from(props).join(', ')} (timing typically ${hoversInSection[0]?.duration} ${hoversInSection[0]?.easing})`);
    }

    return {
      slug: s.slug,
      framerName: sFramer || undefined,
      totalAnimated: inSection.length,
      cdpFired: cdpInSection.length,
      hasParallax,
      hasMarquee,
      hasCharStagger,
      hasViewportFade,
      staggerGroups,
      dominantEasing: dominantEasing || undefined,
      dominantDurationMs: dominantDurationMs || undefined,
      notable,
    };
  });
}

function parseDurationMs(s: string): number {
  if (!s) return 0;
  const t = s.trim();
  if (t.endsWith('ms')) return parseFloat(t);
  if (t.endsWith('s')) return parseFloat(t) * 1000;
  return parseFloat(t) || 0;
}
function topKey<T>(m: Map<T, number>): T | undefined {
  let best: T | undefined; let bestN = 0;
  for (const [k, n] of m) if (n > bestN) { bestN = n; best = k; }
  return best;
}

export async function writeMotionArtifacts(
  outDir: string,
  computedAnimated: AnimatedElement[],
  cdpAnimations: CDPAnimation[],
  stack: DetectedStack
) {
  await mkdir(join(outDir, 'motion'), { recursive: true });
  const animationsJson = {
    capturedAt: new Date().toISOString(),
    stack,
    computed: computedAnimated,
    cdp: cdpAnimations,
  };
  await writeFile(
    join(outDir, 'motion', 'animations.json'),
    JSON.stringify(animationsJson, null, 2),
    'utf8'
  );

  const md = synthesizeMotionSpecs(computedAnimated, cdpAnimations, stack);
  await writeFile(join(outDir, 'motion', 'motion-specs.md'), md, 'utf8');
  console.log(`  🎬 ${computedAnimated.length} animated elements, ${cdpAnimations.length} CDP animations`);
}

function synthesizeMotionSpecs(
  computed: AnimatedElement[],
  cdp: CDPAnimation[],
  stack: DetectedStack
): string {
  const lines: string[] = [];
  lines.push('# Motion Specs\n');
  lines.push(`> Auto-generated from a live capture. Use these EXACT durations and easings when rebuilding.\n`);
  lines.push('## Stack\n');
  lines.push(`- Framework: \`${stack.framework}\``);
  lines.push(`- Framer Motion: ${stack.framerMotion ? '✅' : '❌'}`);
  lines.push(`- Built with Framer: ${stack.framer ? '✅' : '❌'}`);
  lines.push(`- Lenis smooth scroll: ${stack.lenis ? '✅' : '❌'}`);
  lines.push(`- GSAP: ${stack.gsap ? '✅' : '❌'}`);
  lines.push(`- Three.js: ${stack.three ? '✅' : '❌'}`);
  lines.push(`- Spline runtime: ${stack.splineRuntime ? '✅' : '❌'}`);
  if (stack.notes.length) lines.push('\nNotes:\n' + stack.notes.map((n) => `- ${n}`).join('\n'));

  // Cluster easings + durations
  const easingCount = new Map<string, number>();
  const durationCount = new Map<string, number>();
  for (const a of computed) {
    if (a.cssTimingFunction) easingCount.set(a.cssTimingFunction, (easingCount.get(a.cssTimingFunction) ?? 0) + 1);
    if (a.cssDuration) durationCount.set(a.cssDuration, (durationCount.get(a.cssDuration) ?? 0) + 1);
  }
  for (const a of cdp) {
    easingCount.set(a.easing, (easingCount.get(a.easing) ?? 0) + 1);
    const d = `${a.duration}ms`;
    durationCount.set(d, (durationCount.get(d) ?? 0) + 1);
  }

  lines.push('\n## Top easings (use these as defaults)\n');
  const sortedEasings = [...easingCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  for (const [e, n] of sortedEasings) {
    lines.push(`- \`${e}\` — ${n} occurrences ${cubicBezierHint(e)}`);
  }

  lines.push('\n## Top durations\n');
  const sortedDurs = [...durationCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  for (const [d, n] of sortedDurs) {
    lines.push(`- \`${d}\` — ${n} occurrences`);
  }

  // CDP animation summary
  if (cdp.length) {
    lines.push('\n## Captured animations (from CDP)\n');
    lines.push('| # | Type | Duration | Easing | Delay |');
    lines.push('|---|------|----------|--------|-------|');
    for (const [i, a] of cdp.slice(0, 50).entries()) {
      lines.push(`| ${i + 1} | ${a.type} | ${a.duration}ms | \`${a.easing}\` | ${a.delay}ms |`);
    }
  }

  // Notable elements
  const notable = computed.filter((c) => c.cssDuration && parseFloat(c.cssDuration) > 0).slice(0, 30);
  if (notable.length) {
    lines.push('\n## Notable animated elements\n');
    for (const a of notable) {
      lines.push(`### \`${a.tag}\`${a.classes.length ? '.' + a.classes.slice(0, 2).join('.') : ''}`);
      if (a.text) lines.push(`> "${a.text}"`);
      if (a.cssTransition) lines.push(`- transition: \`${a.cssTransition}\``);
      if (a.cssAnimation) lines.push(`- animation: \`${a.cssAnimation}\``);
      lines.push('');
    }
  }

  // Framer-tier defaults cheat sheet
  lines.push('\n## Framer-tier defaults (fallbacks if CDP gave us linear)\n');
  lines.push('```ts');
  lines.push('// Use these arrays directly with Motion (framer-motion):');
  lines.push("const easeOutExpo  = [0.16, 1, 0.3, 1];   // the de facto Framer enter");
  lines.push("const easeOutQuint = [0.22, 1, 0.36, 1];  // softer alt");
  lines.push("const decockExpo   = [0.19, 1, 0.22, 1];  // benjamin de cock special");
  lines.push("const easeInOutQuart = [0.77, 0, 0.175, 1];");
  lines.push("const pageTransition = [0.83, 0, 0.17, 1];");
  lines.push('');
  lines.push('// Common timings');
  lines.push('// hero reveal: 0.8-1.2s, ease-out-expo, stagger 0.1-0.15');
  lines.push('// hover: 0.2-0.3s, ease-out');
  lines.push('// section enter: 0.4-0.6s, ease-out-expo, stagger 0.05-0.08');
  lines.push('```\n');

  if (stack.lenis) {
    lines.push('## Lenis config (detected)\n');
    lines.push('```ts');
    lines.push("import Lenis from 'lenis'");
    lines.push("const lenis = new Lenis({");
    lines.push("  duration: 1.2,");
    lines.push("  easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),");
    lines.push("  smoothWheel: true,");
    lines.push("})");
    lines.push("function raf(time: number) { lenis.raf(time); requestAnimationFrame(raf) }");
    lines.push("requestAnimationFrame(raf)");
    lines.push('```\n');
  }

  return lines.join('\n');
}

function cubicBezierHint(e: string): string {
  if (e.startsWith('cubic-bezier')) {
    const m = e.match(/cubic-bezier\(([^)]+)\)/);
    if (m) {
      const [a, b, c, d] = m[1].split(',').map((s) => parseFloat(s.trim()));
      // Match against common framer easings
      if (close(a, 0.16) && close(b, 1) && close(c, 0.3) && close(d, 1)) return '→ ease-out-expo (Framer default)';
      if (close(a, 0.22) && close(b, 1) && close(c, 0.36) && close(d, 1)) return '→ ease-out-quint';
      if (close(a, 0.19) && close(b, 1) && close(c, 0.22) && close(d, 1)) return '→ De Cock expo';
      if (close(a, 0.77) && close(b, 0) && close(c, 0.175) && close(d, 1)) return '→ ease-in-out-quart';
    }
  }
  if (e === 'ease-out') return '→ generic ease-out';
  if (e === 'linear') return '→ linear (often a marquee or scroll)';
  return '';
}
function close(a: number, b: number) {
  return Math.abs(a - b) < 0.02;
}
