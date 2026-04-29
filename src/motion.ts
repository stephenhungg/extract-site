import { Page, CDPSession } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AnimatedElement, CDPAnimation, DetectedStack } from './types.ts';

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
      out.push({
        selector: selectorFor(el),
        tag: el.tagName.toLowerCase(),
        classes: (el.className && typeof el.className === 'string'
          ? el.className.split(/\s+/).filter(Boolean)
          : []
        ).slice(0, 8),
        text: text || undefined,
        cssTransition: hasTrans ? `${cs.transitionProperty} ${cs.transitionDuration} ${cs.transitionTimingFunction} ${cs.transitionDelay}` : undefined,
        cssAnimation: hasAnim ? `${cs.animationName} ${cs.animationDuration} ${cs.animationTimingFunction} ${cs.animationDelay}` : undefined,
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

export async function recordScrollVideo(
  page: Page,
  outDir: string
): Promise<string | null> {
  // Playwright's per-context recording is set when launching, but we can use
  // CDP screencast instead. Simpler: re-launch with recordVideo per-extraction.
  // For v0.1, skip — leave a placeholder. The static + animation data is enough.
  return null;
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
