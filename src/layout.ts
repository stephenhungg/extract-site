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
  isImage?: boolean;
  isText?: boolean;
  fontSize?: string;
  color?: string;
  bgColor?: string;
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
        const src = (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src;
        if (src) node.imgSrc = src;
      } else if (isText) {
        node.isText = true;
        node.textPreview = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        node.fontSize = cs.fontSize;
        node.color = cs.color;
      }
      if (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') {
        node.bgColor = cs.backgroundColor;
      }

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
