// motion-runtime.ts — the thin layer that ports framer's motion behaviors
// onto our extracted DOM. consumes the JSON specs captured by extract-site
// (appear-effects + scroll-motion) and drives equivalent animations using
// framer-motion's `animate()` primitive (no framer chunks needed).
//
// element matching: every spec carries a `csId` that corresponds to
// `[data-cs-id="N"]` in the rendered DOM. cs-ids are assigned by
// extract-site/src/computed-styles.ts in a deterministic depth-first walk;
// extract-site/src/appear-effects.ts and scroll-motion.ts replicate that
// walk so their cs-ids align.

import { animate } from 'framer-motion';

// ─── types (mirror the JSON shapes from extract-site) ─────────────────

export interface AppearEffectSpec {
  id: string;
  csId: string | null;
  framerName: string | null;
  appearId: string | null;
  initial: Record<string, string>;  // opacity / transform / filter / will-change
  rawStyle: string;
}

export interface ScrollBehaviorSpec {
  selector: string;
  csId?: string;
  framerName?: string;
  tag: string;
  kind: ('pinned' | 'parallax' | 'scroll-scaled' | 'scroll-translated' | 'scroll-faded' | 'pin-scrub' | 'scroll-rotated')[];
  scrollFrom: number;
  scrollTo: number;
  vpTopSlope: number;
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
  bboxStart: { x: number; y: number; w: number; h: number };
  bboxEnd: { x: number; y: number; w: number; h: number };
  text?: string;
  sectionSlug?: string;
}

export interface HoverSpec {
  // either selector OR triggerCsId identifies what you point at
  selector?: string;
  triggerCsId?: string;
  // targetCsId identifies the descendant that visually animates
  targetCsId?: string;
  framerName?: string;
  delta: Record<string, { from: string; to: string }>;
  duration?: string;
  easing?: string;
}

export interface MotionData {
  appear: { effects: AppearEffectSpec[] };
  scroll: { behaviors: ScrollBehaviorSpec[] };
  hover?: HoverSpec[];
}

// ─── element lookup ────────────────────────────────────────────────────

function findElement(spec: { csId?: string | null; framerName?: string | null }): HTMLElement | null {
  if (spec.csId != null) {
    const el = document.querySelector<HTMLElement>(`[data-cs-id="${spec.csId}"]`);
    if (el) return el;
  }
  if (spec.framerName) {
    // CSS attribute selectors don't escape easily; use querySelectorAll fallback
    const all = document.querySelectorAll<HTMLElement>('[data-framer-name]');
    for (const el of Array.from(all)) {
      if (el.getAttribute('data-framer-name') === spec.framerName) return el;
    }
  }
  return null;
}

// ─── appear effects (entry animations on viewport intersect) ──────────

function mountAppearEffects(effects: AppearEffectSpec[]): number {
  let matched = 0;
  // group by viewport: one IntersectionObserver shared across all
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target as HTMLElement;
        const initialJSON = el.dataset.appearInit;
        if (!initialJSON) continue;
        const initial: Record<string, string> = JSON.parse(initialJSON);
        // animate from initial → resting (clear the framer initial overrides)
        const to: Record<string, string | number> = {};
        if ('opacity' in initial) to.opacity = 1;
        if ('transform' in initial) to.transform = 'none';
        if ('filter' in initial) to.filter = 'blur(0px)';
        animate(el, to, {
          duration: 0.8,
          ease: [0.16, 1, 0.3, 1],  // framer's default "smooth" curve
        });
        observer.unobserve(el);
        delete el.dataset.appearInit;
      }
    },
    { rootMargin: '0px 0px -10% 0px', threshold: 0.05 },
  );

  for (const fx of effects) {
    const el = findElement(fx);
    if (!el) continue;
    matched++;
    // apply initial state inline (overrides any current style)
    for (const [prop, val] of Object.entries(fx.initial)) {
      el.style.setProperty(prop, val);
    }
    el.dataset.appearInit = JSON.stringify(fx.initial);
    observer.observe(el);
  }
  return matched;
}

// ─── scroll-linked motion (parallax, pin, scrub) ──────────────────────

interface BoundParallax {
  el: HTMLElement;
  spec: ScrollBehaviorSpec;
  baseDocTop: number;  // element's natural docTop at scroll=0
  baseTransform: string;  // existing transform we need to compose with (e.g. rotate, scale)
}

function mountScrollMotion(behaviors: ScrollBehaviorSpec[]): number {
  const parallaxBindings: BoundParallax[] = [];
  const boundEls = new Set<HTMLElement>();
  let matched = 0;

  // first pass: collect all candidate parallax elements
  const candidates: { el: HTMLElement; spec: ScrollBehaviorSpec }[] = [];
  for (const b of behaviors) {
    const el = findElement(b);
    if (!el) continue;
    matched++;
    if (b.kind.includes('parallax')) {
      candidates.push({ el, spec: b });
    }
  }

  // leaf-only: skip elements whose ancestor is also a parallax candidate.
  // why: parallax translates the element. if both parent and child translate
  // the same delta, they compound visually — child appears to move 2x.
  // framer's runtime composes transforms in a single matrix per element;
  // we approximate by only animating the deepest binding in each chain.
  const candidateSet = new Set(candidates.map((c) => c.el));
  for (const { el, spec } of candidates) {
    let p: HTMLElement | null = el.parentElement;
    let hasAncestorBound = false;
    while (p) {
      if (candidateSet.has(p)) { hasAncestorBound = true; break; }
      p = p.parentElement;
    }
    if (hasAncestorBound) continue;
    const rect = el.getBoundingClientRect();
    const baseDocTop = rect.top + window.scrollY;
    // capture existing transform so we can compose (don't stomp framer's
    // rotate/scale on tilted polaroids etc.). filter out any pre-existing
    // translate3d we might have left from a hot-reload.
    const cs = getComputedStyle(el);
    const baseTransform = cs.transform === 'none' ? '' : cs.transform;
    parallaxBindings.push({ el, spec, baseDocTop, baseTransform });
    boundEls.add(el);
  }
  void boundEls; // for future cross-mount coordination

  // pinned / pin-scrub: framer uses sticky positioning + transform. the
  // inlined computed styles already include `position: sticky` for these
  // when present in source, so the browser handles pinning natively. we'd
  // only need to step in here to tween scale/opacity along the scroll —
  // not implemented yet (TODO: pin-scrub state interpolation).

  if (parallaxBindings.length === 0) return matched;

  let raf = 0;
  let lastY = -1;
  const update = () => {
    raf = 0;
    const y = window.scrollY;
    if (y === lastY) return;
    lastY = y;
    for (const { el, spec, baseDocTop, baseTransform } of parallaxBindings) {
      void baseDocTop;
      if (y < spec.scrollFrom - 200 || y > spec.scrollTo + 200) continue;
      // captured slope: dVpTop/dScrollY. for normal flow it's ≈ -1.
      // parallax delta = (1 + slope) * (y - scrollFrom). compose with the
      // element's existing transform (rotate/scale on tilted polaroids etc.)
      // by prepending a translate3d — translate happens "on top of" the rest.
      const extra = -(y - spec.scrollFrom) * (1 + spec.vpTopSlope);
      const clamped = Math.max(-400, Math.min(400, extra));
      el.style.transform = `translate3d(0, ${clamped.toFixed(2)}px, 0) ${baseTransform}`.trim();
    }
  };

  const onScroll = () => {
    if (raf) return;
    raf = requestAnimationFrame(update);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  update();
  return matched;
}

// ─── hover effects (whileHover replay) ────────────────────────────────

function parseDur(s?: string): number {
  if (!s) return 0.2;
  const v = parseFloat(s);
  if (s.endsWith('ms')) return v / 1000;
  return v || 0.2;
}

function mountHover(specs: HoverSpec[]): number {
  let matched = 0;
  for (const spec of specs) {
    const triggerSel = spec.triggerCsId
      ? `[data-cs-id="${spec.triggerCsId}"]`
      : spec.selector;
    if (!triggerSel) continue;
    const trigger = document.querySelector<HTMLElement>(triggerSel);
    if (!trigger) continue;
    // target = the descendant that visually changes; falls back to trigger
    const target = spec.targetCsId
      ? document.querySelector<HTMLElement>(`[data-cs-id="${spec.targetCsId}"]`) ?? trigger
      : trigger;
    matched++;

    const dur = parseDur(spec.duration);
    const fromValues: Record<string, string> = {};
    const toValues: Record<string, string | number> = {};
    for (const [prop, { from, to }] of Object.entries(spec.delta)) {
      // prop names from extract-site are camelCase getComputedStyle keys.
      // animate() can take camelCase too; framer-motion normalizes.
      fromValues[prop] = from;
      toValues[prop] = to;
    }

    let activeAnim: { stop: () => void } | null = null;
    const onEnter = () => {
      if (activeAnim) activeAnim.stop();
      const anim = animate(target, toValues, { duration: dur, ease: [0.16, 1, 0.3, 1] });
      activeAnim = { stop: () => anim.stop() };
    };
    const onLeave = () => {
      if (activeAnim) activeAnim.stop();
      const anim = animate(target, fromValues, { duration: dur, ease: [0.16, 1, 0.3, 1] });
      activeAnim = { stop: () => anim.stop() };
    };
    trigger.addEventListener('pointerenter', onEnter);
    trigger.addEventListener('pointerleave', onLeave);
  }
  return matched;
}

// ─── public mount ──────────────────────────────────────────────────────

export interface MountOptions {
  // parallax is on by default in v0.6+ (classifier was tightened in
  // scroll-motion.ts to skip structural elements; runtime composes with
  // existing transforms instead of stomping). pass false to disable.
  enableParallax?: boolean;
}

export interface MountResult {
  appearMatched: number;
  appearTotal: number;
  scrollMatched: number;
  scrollTotal: number;
  hoverMatched: number;
  hoverTotal: number;
}

export function mountMotion(data: MotionData, opts: MountOptions = {}): MountResult {
  const enableParallax = opts.enableParallax ?? true;
  const appearMatched = mountAppearEffects(data.appear?.effects ?? []);
  const scrollMatched = enableParallax
    ? mountScrollMotion(data.scroll?.behaviors ?? [])
    : 0;
  const hoverMatched = mountHover(data.hover ?? []);
  const result: MountResult = {
    appearMatched,
    appearTotal: data.appear?.effects?.length ?? 0,
    scrollMatched,
    scrollTotal: data.scroll?.behaviors?.length ?? 0,
    hoverMatched,
    hoverTotal: data.hover?.length ?? 0,
  };
  console.log(
    `[motion-runtime] mounted: appear ${result.appearMatched}/${result.appearTotal}, scroll ${result.scrollMatched}/${result.scrollTotal}, hover ${result.hoverMatched}/${result.hoverTotal}`,
  );
  return result;
}
