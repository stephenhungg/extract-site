import { Page } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SectionInfo, Viewport } from './types.ts';

export async function detectSections(page: Page): Promise<SectionInfo[]> {
  return await page.evaluate(() => {
    function selectorFor(el: Element): string {
      if (el.id) return `#${CSS.escape(el.id)}`;
      const tag = el.tagName.toLowerCase();
      const cls = (el as HTMLElement).className && typeof (el as HTMLElement).className === 'string'
        ? (el as HTMLElement).className.trim().split(/\s+/).slice(0, 2).join('.')
        : '';
      const parent = el.parentElement;
      if (!parent) return tag;
      const idx = Array.from(parent.children).filter((c) => c.tagName === el.tagName).indexOf(el);
      return cls ? `${tag}.${cls}` : `${tag}:nth-of-type(${idx + 1})`;
    }

    function slugify(s: string) {
      return (s || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40) || 'section';
    }

    // Strategy: prefer real <section> tags; fallback to top-level children of <main> or <body>;
    // last resort: viewport-height chunks.
    let candidates: Element[] = Array.from(document.querySelectorAll('section'));
    if (candidates.length < 3) {
      const root = document.querySelector('main') || document.body;
      candidates = Array.from(root.children).filter((c) => {
        const r = c.getBoundingClientRect();
        return r.height > 200;
      });
    }

    const results: any[] = [];
    candidates.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      const text = (el.textContent || '').trim().slice(0, 60);
      results.push({
        index: i + 1,
        slug: `${String(i + 1).padStart(2, '0')}-${slugify(text || el.tagName)}`,
        selector: selectorFor(el),
        bbox: {
          x: Math.round(r.left + window.scrollX),
          y: Math.round(r.top + window.scrollY),
          width: Math.round(r.width),
          height: Math.round(r.height),
        },
        tag: el.tagName.toLowerCase(),
        textPreview: text,
      });
    });
    return results;
  });
}

export async function captureSectionScreenshots(
  page: Page,
  outDir: string,
  sections: SectionInfo[],
  viewports: Viewport[]
) {
  await mkdir(join(outDir, 'screenshots', 'sections'), { recursive: true });
  await mkdir(join(outDir, 'dom', 'sections'), { recursive: true });

  for (const vp of viewports) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.waitForTimeout(400);

    for (const section of sections) {
      try {
        // Re-query bbox + page dimensions at this viewport since layout shifts
        const live = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          el.scrollIntoView({ block: 'start', behavior: 'instant' as ScrollBehavior });
          const r = el.getBoundingClientRect();
          return {
            x: Math.round(r.left + window.scrollX),
            y: Math.round(r.top + window.scrollY),
            width: Math.round(r.width),
            height: Math.round(r.height),
            docHeight: Math.max(
              document.documentElement.scrollHeight,
              document.body.scrollHeight
            ),
            html: el.outerHTML.slice(0, 200000),
          };
        }, section.selector);
        if (!live) continue;
        if (live.width === 0 || live.height === 0) continue; // hidden at this vp
        await page.waitForTimeout(300);
        const path = join(outDir, 'screenshots', 'sections', `${section.slug}-${vp.name}.png`);
        const clipY = Math.max(0, Math.min(live.y, live.docHeight - 1));
        const clipHeight = Math.max(
          1,
          Math.min(live.height, live.docHeight - clipY, 4000)
        );
        await page.screenshot({
          path,
          fullPage: true,
          clip: {
            x: 0,
            y: clipY,
            width: vp.width,
            height: clipHeight,
          },
        });
        if (vp.name === 'desktop') {
          await writeFile(
            join(outDir, 'dom', 'sections', `${section.slug}.html`),
            live.html,
            'utf8'
          );
        }
      } catch (e) {
        console.warn(`  ⚠️  failed section ${section.slug} @ ${vp.name}:`, (e as Error).message);
      }
    }
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  console.log(`  🧩 ${sections.length} sections × ${viewports.length} viewports`);
}
