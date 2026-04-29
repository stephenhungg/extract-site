import { Page } from 'playwright';
import { writeFile, mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';

// During-scroll sampler. Walks the page in fixed pixel steps, and at every
// rest point captures a viewport screenshot, the set of <img> elements that
// finished loading since the previous sample (i.e. lazy-loaded images),
// the data-framer-name elements that are now in view, and the current
// scrollY. Output goes to samples/.
//
// Why this matters for extraction:
// - Lazy-loaded images that wouldn't appear in a single autoScroll-then-snap
//   pass DO appear in the inter-step deltas.
// - Scroll-driven motion (parallax, color shifts, sticky cards) is recorded
//   at multiple positions, so the rebuild has ground-truth keyframes.
// - "What enters the viewport at scrollY=X" is a much cleaner mental model
//   for replicating intersection-triggered animations than reading CDP logs.

export interface ScrollSample {
  index: number;
  ts: string;
  scrollY: number;
  scrollPct: number; // 0-1
  viewportH: number;
  screenshot: string; // relative path
  newImages: { src: string; alt: string; bbox: { x: number; y: number; w: number; h: number } }[];
  visibleFramerNames: string[];
  visibleSelectors: string[]; // top-level data-framer-name elements in viewport
}

export async function sampledScrollCapture(
  page: Page,
  outDir: string,
  opts: { stepPx?: number; pauseMs?: number; maxSamples?: number } = {}
): Promise<ScrollSample[]> {
  const stepPx = opts.stepPx ?? 600;
  const pauseMs = opts.pauseMs ?? 350;
  const maxSamples = opts.maxSamples ?? 60;

  const samplesDir = join(outDir, 'samples');
  const shotsDir = join(samplesDir, 'screenshots');
  await mkdir(shotsDir, { recursive: true });
  const indexPath = join(samplesDir, 'index.jsonl');
  await writeFile(indexPath, '', 'utf8');

  // Reset to top, install image-load tracker so we can compute deltas.
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    (window as any).__seenImgs = new Set<string>();
  });
  await page.waitForTimeout(300);

  const totalH: number = await page.evaluate(() => document.documentElement.scrollHeight);
  const samples: ScrollSample[] = [];
  let scrollY = 0;
  let i = 0;

  while (i < maxSamples) {
    await page.evaluate((y) => window.scrollTo(0, y), scrollY);
    await page.waitForTimeout(pauseMs);

    const probe = await page.evaluate(() => {
      const seen = (window as any).__seenImgs as Set<string>;
      const newImgs: { src: string; alt: string; bbox: any }[] = [];
      for (const img of Array.from(document.images)) {
        const src = img.currentSrc || img.src;
        if (!src || seen.has(src)) continue;
        if (!img.complete || img.naturalWidth === 0) continue;
        seen.add(src);
        const r = img.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) continue;
        newImgs.push({
          src,
          alt: img.alt || '',
          bbox: { x: Math.round(r.left), y: Math.round(r.top + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) },
        });
      }

      // Top-level visible framer-named elements in the current viewport
      const vpTop = window.scrollY;
      const vpBot = vpTop + window.innerHeight;
      const visibleFramerNames: string[] = [];
      const visibleSelectors: string[] = [];
      document.querySelectorAll('[data-framer-name]').forEach((el) => {
        const r = el.getBoundingClientRect();
        const top = r.top + window.scrollY;
        const bot = top + r.height;
        if (bot < vpTop || top > vpBot) return;
        const name = (el as HTMLElement).dataset.framerName || '';
        if (name && !visibleFramerNames.includes(name)) {
          visibleFramerNames.push(name);
          const id = (el as HTMLElement).id;
          visibleSelectors.push(id ? `#${id}` : `[data-framer-name="${name}"]`);
        }
      });

      return {
        scrollY: window.scrollY,
        viewportH: window.innerHeight,
        totalH: document.documentElement.scrollHeight,
        newImgs,
        visibleFramerNames: visibleFramerNames.slice(0, 12),
        visibleSelectors: visibleSelectors.slice(0, 12),
      };
    });

    const shotName = `${String(i).padStart(3, '0')}.png`;
    const shotPath = join(shotsDir, shotName);
    await page.screenshot({ path: shotPath, fullPage: false });

    const sample: ScrollSample = {
      index: i,
      ts: new Date().toISOString(),
      scrollY: probe.scrollY,
      scrollPct: probe.totalH > 0 ? Math.round((probe.scrollY / probe.totalH) * 1000) / 1000 : 0,
      viewportH: probe.viewportH,
      screenshot: `samples/screenshots/${shotName}`,
      newImages: probe.newImgs,
      visibleFramerNames: probe.visibleFramerNames,
      visibleSelectors: probe.visibleSelectors,
    };
    samples.push(sample);
    await appendFile(indexPath, JSON.stringify(sample) + '\n', 'utf8');

    if (probe.scrollY + probe.viewportH >= probe.totalH - 8) break;
    scrollY = Math.min(scrollY + stepPx, totalH);
    i++;
  }

  // Reset
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);

  // Summary: timeline.md — easy human read
  const lines: string[] = ['# Scroll sampler timeline', ''];
  lines.push(`Captured ${samples.length} samples while scrolling. Each entry shows the scroll position, what newly loaded into the page, and which framer-named regions were on screen.`);
  lines.push('');
  for (const s of samples) {
    lines.push(`## sample ${String(s.index).padStart(3, '0')} — y=${s.scrollY} (${(s.scrollPct * 100).toFixed(0)}%)`);
    lines.push(`![](${s.screenshot})`);
    if (s.visibleFramerNames.length) {
      lines.push(`**In viewport:** ${s.visibleFramerNames.map((n) => `\`${n}\``).join(' · ')}`);
    }
    if (s.newImages.length) {
      lines.push(`**Lazy-loaded here (${s.newImages.length}):**`);
      for (const im of s.newImages.slice(0, 8)) {
        lines.push(`- \`${im.src.split('/').pop()?.split('?')[0]}\`${im.alt ? ` — "${im.alt}"` : ''}`);
      }
    }
    lines.push('');
  }
  await writeFile(join(samplesDir, 'timeline.md'), lines.join('\n'), 'utf8');

  console.log(`  📼 ${samples.length} scroll samples (lazy-image deltas + viewport state)`);
  return samples;
}
