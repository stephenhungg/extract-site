import { Page } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SectionInfo } from './types.ts';

export interface LayoutNode {
  tag: string;
  classes: string[];
  framerName?: string;
  bbox: { x: number; y: number; width: number; height: number };
  display: string;
  flexDirection?: string;
  justifyContent?: string;
  alignItems?: string;
  gap?: string;
  gridTemplateColumns?: string;
  gridTemplateRows?: string;
  position: string;
  zIndex: string;
  textPreview?: string;
  imgSrc?: string;
  imgSrcset?: string;
  isImage?: boolean;
  isText?: boolean;
  fontSize?: string;
  fontWeight?: string;
  fontFamily?: string;
  lineHeight?: string;
  letterSpacing?: string;
  textTransform?: string;
  color?: string;
  bgColor?: string;
  // Frontier visual styling — what makes the difference between generic
  // and "looks like the source":
  borderRadius?: string;          // e.g. "16px" or "16px 16px 0 0"
  border?: string;                // shorthand: "1px solid rgb(...)"
  boxShadow?: string;             // captured raw — e.g. "0 24px 48px rgba(0,0,0,0.4)"
  backdropFilter?: string;        // e.g. "blur(20px)"
  filter?: string;                // e.g. "blur(2px) brightness(1.1)"
  transform?: string;             // resting transform (matrix or composed)
  opacity?: string;               // !== "1"
  bgImage?: string;               // raw computed background-image value (incl. gradients)
  gradient?: { kind: 'linear' | 'radial' | 'conic'; stops: { color: string; pos?: string }[]; direction?: string };
  padding?: string;               // shorthand
  margin?: string;                // shorthand (rare, but sometimes load-bearing)
  overflow?: string;
  cursor?: string;                // marks "interactive" elements for hover capture later
  children: LayoutNode[];
}

// Walk a section's DOM and produce a structural layout tree, pruning depth
// and noise. Useful for an LLM to understand the layout grid without parsing
// 200KB of compiled HTML.
export async function extractSectionLayouts(
  page: Page,
  sections: SectionInfo[]
): Promise<{ slug: string; layout: LayoutNode }[]> {
  return await page.evaluate((sectionsArg) => {
    const MAX_DEPTH = 8;
    const MAX_CHILDREN = 12;

    function classListOf(el: Element): string[] {
      const cn = (el as HTMLElement).className;
      if (typeof cn !== 'string') return [];
      return cn.trim().split(/\s+/).filter(Boolean).slice(0, 5);
    }
    function isVisible(el: Element): boolean {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 4 && r.height > 4;
    }
    function bboxOf(el: Element) {
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height),
      };
    }
    function collapseChild(child: Element): boolean {
      // Skip wrapper-only divs that don't add layout meaning
      const cs = getComputedStyle(child);
      if (cs.display === 'contents') return true;
      if (child.children.length === 1 && !(child.tagName === 'A')) {
        const onlyChild = child.children[0];
        const r1 = child.getBoundingClientRect();
        const r2 = onlyChild.getBoundingClientRect();
        if (Math.abs(r1.width - r2.width) < 2 && Math.abs(r1.height - r2.height) < 2) {
          return true;
        }
      }
      return false;
    }
    function parseGradient(bg: string) {
      // Match the FIRST gradient in background-image. Most framer elements
      // use a single gradient; layered gradients are rare and we keep the
      // raw string in bgImage for fidelity.
      const m = bg.match(/(linear|radial|conic)-gradient\(([^)]*(?:\([^)]*\)[^)]*)*)\)/);
      if (!m) return null;
      const kind = m[1] as 'linear' | 'radial' | 'conic';
      const inner = m[2];
      // direction = first chunk if it doesn't start with a color
      const parts = inner.split(/,(?![^()]*\))/).map((s) => s.trim());
      let direction: string | undefined;
      let stops = parts;
      if (parts.length && /^(to |[\d.]+(deg|rad|turn|%)|from |at )/i.test(parts[0])) {
        direction = parts[0];
        stops = parts.slice(1);
      }
      return {
        kind,
        direction,
        stops: stops.map((s) => {
          const sm = s.match(/^(.+?)(?:\s+([\d.]+(?:%|px|em|rem)))?\s*$/);
          return sm ? { color: sm[1].trim(), pos: sm[2] } : { color: s };
        }),
      };
    }
    function walk(el: Element, depth: number): any {
      const cs = getComputedStyle(el);
      const tag = el.tagName.toLowerCase();
      const isImg = tag === 'img' || tag === 'video' || tag === 'svg';
      const isText =
        ['h1','h2','h3','h4','h5','h6','p','span','a','button','li'].includes(tag) &&
        (el.textContent || '').trim().length > 0 &&
        el.children.length === 0;

      const node: any = {
        tag,
        classes: classListOf(el),
        bbox: bboxOf(el),
        display: cs.display,
        position: cs.position,
        zIndex: cs.zIndex,
        children: [],
      };
      const framerName = (el as HTMLElement).dataset?.framerName;
      if (framerName) node.framerName = framerName;
      if (cs.display.includes('flex')) {
        node.flexDirection = cs.flexDirection;
        node.justifyContent = cs.justifyContent;
        node.alignItems = cs.alignItems;
        node.gap = cs.gap;
      }
      if (cs.display.includes('grid')) {
        node.gridTemplateColumns = cs.gridTemplateColumns;
        node.gridTemplateRows = cs.gridTemplateRows;
        node.gap = cs.gap;
      }
      if (isImg) {
        node.isImage = true;
        const img = el as HTMLImageElement;
        const src = img.currentSrc || img.src;
        if (src) node.imgSrc = src;
        if ('srcset' in img && img.srcset) node.imgSrcset = img.srcset;
      } else if (isText) {
        node.isText = true;
        node.textPreview = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        node.fontSize = cs.fontSize;
        node.fontWeight = cs.fontWeight;
        node.fontFamily = cs.fontFamily;
        node.lineHeight = cs.lineHeight;
        if (cs.letterSpacing && cs.letterSpacing !== 'normal') node.letterSpacing = cs.letterSpacing;
        if (cs.textTransform && cs.textTransform !== 'none') node.textTransform = cs.textTransform;
        node.color = cs.color;
      }
      if (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') {
        node.bgColor = cs.backgroundColor;
      }
      // Frontier visual styling — only emit when meaningful (non-default).
      if (cs.borderRadius && cs.borderRadius !== '0px') node.borderRadius = cs.borderRadius;
      // Border: prefer the shorthand if it's uniform; otherwise pick whichever side is non-zero.
      const borderTop = `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`;
      if (cs.borderTopWidth !== '0px' && cs.borderTopStyle !== 'none') {
        node.border = borderTop;
      }
      if (cs.boxShadow && cs.boxShadow !== 'none') node.boxShadow = cs.boxShadow;
      if (cs.backdropFilter && cs.backdropFilter !== 'none') node.backdropFilter = cs.backdropFilter;
      if (cs.filter && cs.filter !== 'none') node.filter = cs.filter;
      if (cs.transform && cs.transform !== 'none' && cs.transform !== 'matrix(1, 0, 0, 1, 0, 0)') {
        node.transform = cs.transform;
      }
      if (cs.opacity && cs.opacity !== '1') node.opacity = cs.opacity;
      if (cs.backgroundImage && cs.backgroundImage !== 'none') {
        node.bgImage = cs.backgroundImage;
        const grad = parseGradient(cs.backgroundImage);
        if (grad) node.gradient = grad;
      }
      // padding + margin: emit shorthand only if any side is non-zero
      const padNonZero = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].some(
        (k) => (cs as any)[k] !== '0px'
      );
      if (padNonZero) {
        node.padding = `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`;
      }
      const marNonZero = ['marginTop', 'marginRight', 'marginBottom', 'marginLeft'].some(
        (k) => (cs as any)[k] !== '0px' && (cs as any)[k] !== 'auto'
      );
      if (marNonZero) {
        node.margin = `${cs.marginTop} ${cs.marginRight} ${cs.marginBottom} ${cs.marginLeft}`;
      }
      if (cs.overflow && cs.overflow !== 'visible') node.overflow = cs.overflow;
      if (cs.cursor && cs.cursor !== 'auto' && cs.cursor !== 'default') node.cursor = cs.cursor;

      if (depth >= MAX_DEPTH) return node;
      const kids: Element[] = [];
      for (const child of Array.from(el.children)) {
        if (!isVisible(child)) continue;
        if (collapseChild(child)) {
          // descend into the collapsed child's children directly
          for (const grand of Array.from(child.children)) {
            if (isVisible(grand)) kids.push(grand);
          }
        } else {
          kids.push(child);
        }
      }
      const sliced = kids.slice(0, MAX_CHILDREN);
      node.children = sliced.map((k) => walk(k, depth + 1));
      return node;
    }

    const out: any[] = [];
    for (const s of sectionsArg) {
      const root = document.querySelector(s.selector);
      if (!root) continue;
      out.push({ slug: s.slug, layout: walk(root, 0) });
    }
    return out;
  }, sections as any);
}

export async function writeLayoutArtifacts(
  outDir: string,
  layouts: { slug: string; layout: LayoutNode }[]
) {
  await mkdir(join(outDir, 'content'), { recursive: true });
  await writeFile(
    join(outDir, 'content', 'layouts.json'),
    JSON.stringify(layouts, null, 2),
    'utf8'
  );
  console.log(`  🏗  layouts.json with ${layouts.length} structural trees`);
}
