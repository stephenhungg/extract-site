import { Page } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SectionInfo, AssetManifestEntry } from './types.ts';

export interface BBox { x: number; y: number; width: number; height: number }

export interface SectionContent {
  index: number;
  slug: string;
  selector: string;
  bbox: BBox;
  framer: { name?: string; componentType?: string; attrs: Record<string, string> };
  text: {
    headings: { level: number; text: string; classes: string[]; bbox: BBox; style: TextStyle }[];
    paragraphs: { text: string; classes: string[]; style: TextStyle }[];
    buttons: { text: string; tag: string; classes: string[]; style: TextStyle }[];
    links: { text: string; href: string; classes: string[] }[];
    labels: string[]; // small uppercase eyebrows / chips
  };
  images: {
    src: string;
    alt: string;
    bbox: BBox;
    role: string;
    localPath?: string;
    srcset?: string;
    srcsetEntries?: { url: string; descriptor: string }[];
    sizes?: string;
    loading?: string;
    decoding?: string;
  }[];
  videos: {
    src: string;
    poster?: string;
    bbox: BBox;
    localPath?: string;
    autoplay?: boolean;
    loop?: boolean;
    muted?: boolean;
    playsInline?: boolean;
    duration?: number;
  }[];
  backgrounds: { selector: string; url: string; localPath?: string }[];
  svgs: { id?: string; outerHTML: string }[];
}

export interface TextStyle {
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
  letterSpacing: string;
  color: string;
  textTransform: string;
  fontStyle: string;
}

export async function extractSectionContent(
  page: Page,
  sections: SectionInfo[]
): Promise<SectionContent[]> {
  return await page.evaluate((sectionsArg) => {
    function bboxOf(el: Element): BBox {
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.left + window.scrollX),
        y: Math.round(r.top + window.scrollY),
        width: Math.round(r.width),
        height: Math.round(r.height),
      };
    }
    function classListOf(el: Element): string[] {
      const cn = (el as HTMLElement).className;
      if (typeof cn !== 'string') return [];
      return cn.trim().split(/\s+/).filter(Boolean).slice(0, 8);
    }
    function styleOf(el: Element): TextStyle {
      const cs = getComputedStyle(el);
      return {
        fontFamily: cs.fontFamily,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        lineHeight: cs.lineHeight,
        letterSpacing: cs.letterSpacing,
        color: cs.color,
        textTransform: cs.textTransform,
        fontStyle: cs.fontStyle,
      };
    }
    function txt(el: Element) {
      return (el.textContent || '').replace(/\s+/g, ' ').trim();
    }
    function isVisible(el: Element): boolean {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }
    function backgroundUrls(el: Element): string[] {
      const cs = getComputedStyle(el);
      const bg = cs.backgroundImage;
      if (!bg || bg === 'none') return [];
      const urls: string[] = [];
      const re = /url\((['"]?)([^'"\)]+)\1\)/g;
      let m;
      while ((m = re.exec(bg))) urls.push(m[2]);
      return urls.filter((u) => !u.startsWith('data:'));
    }

    type BBox = { x: number; y: number; width: number; height: number };
    type TextStyle = {
      fontFamily: string;
      fontSize: string;
      fontWeight: string;
      lineHeight: string;
      letterSpacing: string;
      color: string;
      textTransform: string;
      fontStyle: string;
    };

    const out: any[] = [];
    for (const s of sectionsArg) {
      const root = document.querySelector(s.selector);
      if (!root) continue;

      // framer attrs (any data-framer-* on root or children)
      const framerAttrs: Record<string, string> = {};
      const rootEl = root as HTMLElement;
      for (const attr of Array.from(rootEl.attributes)) {
        if (attr.name.startsWith('data-framer')) framerAttrs[attr.name] = attr.value;
      }

      // text
      const headings: any[] = [];
      root.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((h) => {
        if (!isVisible(h)) return;
        const text = txt(h);
        if (!text) return;
        headings.push({
          level: parseInt(h.tagName[1]),
          text,
          classes: classListOf(h),
          bbox: bboxOf(h),
          style: styleOf(h),
        });
      });

      const paragraphs: any[] = [];
      root.querySelectorAll('p').forEach((p) => {
        if (!isVisible(p)) return;
        const text = txt(p);
        if (!text || text.length < 3) return;
        paragraphs.push({ text, classes: classListOf(p), style: styleOf(p) });
      });

      const buttons: any[] = [];
      root.querySelectorAll('button, [role="button"]').forEach((b) => {
        if (!isVisible(b)) return;
        const text = txt(b);
        if (!text) return;
        buttons.push({ text, tag: b.tagName.toLowerCase(), classes: classListOf(b), style: styleOf(b) });
      });

      const links: any[] = [];
      root.querySelectorAll('a').forEach((a) => {
        if (!isVisible(a)) return;
        const text = txt(a);
        if (!text || text.length < 1) return;
        links.push({ text, href: (a as HTMLAnchorElement).href || '', classes: classListOf(a) });
      });

      // labels: small uppercase eyebrows (text-transform: uppercase, small)
      const labels = new Set<string>();
      root.querySelectorAll('span, div').forEach((el) => {
        if (!isVisible(el)) return;
        const cs = getComputedStyle(el);
        if (cs.textTransform === 'uppercase' && parseFloat(cs.fontSize) <= 16) {
          const text = txt(el);
          if (text && text.length > 1 && text.length < 60) labels.add(text);
        }
      });

      // images
      function parseSrcset(s: string) {
        if (!s) return [] as { url: string; descriptor: string }[];
        return s.split(',').map((entry) => {
          const trimmed = entry.trim();
          const sp = trimmed.lastIndexOf(' ');
          if (sp === -1) return { url: trimmed, descriptor: '' };
          return { url: trimmed.slice(0, sp), descriptor: trimmed.slice(sp + 1) };
        });
      }
      const images: any[] = [];
      root.querySelectorAll('img').forEach((img) => {
        const el = img as HTMLImageElement;
        if (!isVisible(el)) return;
        const bbox = bboxOf(el);
        if (bbox.width < 8 || bbox.height < 8) return; // skip tiny/tracking pixels
        const role =
          bbox.width > 600 && bbox.height > 300
            ? 'hero-or-large'
            : bbox.width > 200
            ? 'medium'
            : 'small';
        const srcset = el.srcset || '';
        const out: any = {
          src: el.currentSrc || el.src,
          alt: el.alt || '',
          bbox,
          role,
        };
        if (srcset) {
          out.srcset = srcset;
          out.srcsetEntries = parseSrcset(srcset);
        }
        if (el.sizes) out.sizes = el.sizes;
        if (el.loading) out.loading = el.loading;
        if (el.decoding) out.decoding = el.decoding;
        images.push(out);
      });

      // videos
      const videos: any[] = [];
      root.querySelectorAll('video').forEach((v) => {
        const el = v as HTMLVideoElement;
        if (!isVisible(el)) return;
        const src =
          el.currentSrc ||
          el.src ||
          (el.querySelector('source') as HTMLSourceElement | null)?.src ||
          '';
        if (!src) return;
        videos.push({
          src,
          poster: el.poster,
          bbox: bboxOf(el),
          autoplay: el.autoplay,
          loop: el.loop,
          muted: el.muted,
          playsInline: el.playsInline,
          duration: isFinite(el.duration) ? el.duration : undefined,
        });
      });

      // background images via computed style scan
      const backgrounds: any[] = [];
      const seenBg = new Set<string>();
      root.querySelectorAll('*').forEach((el) => {
        if (!isVisible(el)) return;
        for (const url of backgroundUrls(el)) {
          if (seenBg.has(url)) continue;
          seenBg.add(url);
          backgrounds.push({
            selector:
              (el as HTMLElement).id ? `#${(el as HTMLElement).id}` : el.tagName.toLowerCase() + '.' + classListOf(el).slice(0, 2).join('.'),
            url,
          });
        }
      });

      // svgs
      const svgs: any[] = [];
      root.querySelectorAll('svg').forEach((svg) => {
        if (!isVisible(svg)) return;
        const r = svg.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) return;
        svgs.push({
          id: (svg as SVGElement).id || undefined,
          outerHTML: svg.outerHTML.slice(0, 8000),
        });
      });

      out.push({
        index: s.index,
        slug: s.slug,
        selector: s.selector,
        bbox: s.bbox,
        framer: {
          name: framerAttrs['data-framer-name'],
          componentType: framerAttrs['data-framer-component-type'],
          attrs: framerAttrs,
        },
        text: { headings, paragraphs, buttons, links, labels: Array.from(labels) },
        images,
        videos,
        backgrounds,
        svgs,
      });
    }
    return out;
  }, sections as any);
}

export function linkAssetsToSections(
  manifest: AssetManifestEntry[],
  contents: SectionContent[]
): AssetManifestEntry[] {
  // Build url -> [section slugs]
  const urlToSections = new Map<string, Set<string>>();
  for (const c of contents) {
    const urls = new Set<string>();
    for (const img of c.images) urls.add(img.src);
    for (const v of c.videos) urls.add(v.src);
    for (const b of c.backgrounds) urls.add(b.url);
    for (const u of urls) {
      if (!urlToSections.has(u)) urlToSections.set(u, new Set());
      urlToSections.get(u)!.add(c.slug);
    }
  }

  // attach usedIn to each manifest entry
  return manifest.map((entry) => {
    const used = urlToSections.get(entry.originalUrl);
    return { ...entry, usedIn: used ? Array.from(used) : [] } as any;
  });
}

export async function writeContentArtifacts(
  outDir: string,
  contents: SectionContent[],
  augmentedManifest: any[]
) {
  await mkdir(join(outDir, 'content'), { recursive: true });
  await writeFile(
    join(outDir, 'content', 'sections.json'),
    JSON.stringify(contents, null, 2),
    'utf8'
  );

  // human-readable text dump
  const txtLines: string[] = ['# Page text content (extracted)\n'];
  for (const c of contents) {
    txtLines.push(`\n## ${c.slug}\n`);
    if (c.framer.name) txtLines.push(`*framer name: ${c.framer.name}*\n`);
    if (c.text.labels.length) {
      txtLines.push('**Labels:** ' + c.text.labels.map((l) => `\`${l}\``).join(' · '));
    }
    for (const h of c.text.headings) {
      txtLines.push(`\n### ${h.text}  *(h${h.level}, ${h.style.fontSize}, ${h.style.color})*`);
    }
    for (const p of c.text.paragraphs) {
      txtLines.push(`\n${p.text}`);
    }
    if (c.text.buttons.length) {
      txtLines.push('\n**Buttons:** ' + c.text.buttons.map((b) => `\`${b.text}\``).join(' · '));
    }
    if (c.images.length) {
      txtLines.push(`\n**Images (${c.images.length}):**`);
      for (const img of c.images.slice(0, 8)) {
        txtLines.push(
          `- ${img.role} \`${img.src.split('/').pop()}\` ${img.bbox.width}×${img.bbox.height}${img.alt ? ` "${img.alt}"` : ''}`
        );
      }
    }
    if (c.videos.length) {
      txtLines.push(`\n**Videos:** ${c.videos.map((v) => v.src.split('/').pop()).join(', ')}`);
    }
    if (c.backgrounds.length) {
      txtLines.push(
        `\n**Background images:** ${c.backgrounds.map((b) => b.url.split('/').pop()).join(', ')}`
      );
    }
  }
  await writeFile(join(outDir, 'content', 'text.md'), txtLines.join('\n'), 'utf8');

  // overwrite manifest with usedIn data
  await writeFile(
    join(outDir, 'assets', 'manifest.json'),
    JSON.stringify(augmentedManifest, null, 2),
    'utf8'
  );

  console.log(`  📝 content.json + text.md (${contents.length} sections)`);
}

// Add a final pass: pick up any background-image URLs that weren't network-intercepted
// (sometimes CSS bg images are already cached or loaded before our listener attaches).
export async function harvestBackgroundImages(
  page: Page,
  outDir: string,
  manifest: AssetManifestEntry[]
): Promise<AssetManifestEntry[]> {
  const allBgUrls: string[] = await page.evaluate(() => {
    const urls = new Set<string>();
    document.querySelectorAll('*').forEach((el) => {
      const cs = getComputedStyle(el);
      const bg = cs.backgroundImage;
      if (!bg || bg === 'none') return;
      const re = /url\((['"]?)([^'"\)]+)\1\)/g;
      let m;
      while ((m = re.exec(bg))) {
        if (!m[2].startsWith('data:')) urls.add(m[2]);
      }
    });
    return Array.from(urls);
  });

  const have = new Set(manifest.map((m) => m.originalUrl));
  const missing = allBgUrls.filter((u) => !have.has(u));
  if (missing.length) {
    console.log(`  🔍 ${missing.length} additional background-image URLs found via computed styles`);
  }
  return manifest;
}
