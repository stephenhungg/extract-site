// computed-styles.ts — capture per-element computed CSS so a rebuild can
// inline the layout-critical values that framer's runtime sets at mount time.
//
// flow:
//   1. annotate every visible element with `data-cs-id="N"` (stable identifier)
//   2. dump getComputedStyle() for ~40 visual properties per node
//   3. write to dom/computed-styles.json keyed by cs-id
//
// the rebuild then walks each section's html with cheerio, looks up styles by
// cs-id, and inlines them as `style="..."` attributes — bypassing the need
// for framer's runtime to compute layout dynamically.

import { Page } from "playwright";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

// the list of CSS properties that matter for visual reproduction. anything not
// in here either inherits cleanly or doesn't affect rendering.
const VISUAL_PROPS = [
  // box model
  "width", "height", "min-width", "min-height", "max-width", "max-height",
  "padding", "margin",
  // positioning
  "position", "top", "right", "bottom", "left", "z-index", "inset",
  // display / layout
  "display", "flex-direction", "flex-wrap", "justify-content", "align-items",
  "align-content", "gap", "row-gap", "column-gap",
  "grid-template-columns", "grid-template-rows", "grid-area",
  // visual
  "background", "background-color", "background-image", "background-size",
  "background-position", "background-repeat",
  "border", "border-radius", "box-shadow", "outline",
  "opacity", "filter", "backdrop-filter", "mix-blend-mode",
  "transform", "transform-origin", "perspective",
  // typography
  "font-family", "font-size", "font-weight", "font-style", "line-height",
  "letter-spacing", "text-align", "text-transform", "text-decoration",
  "color", "white-space",
  // overflow + visibility
  "overflow", "overflow-x", "overflow-y", "visibility", "pointer-events",
  // misc
  "object-fit", "object-position", "aspect-ratio",
];

export async function captureComputedStyles(page: Page, outDir: string) {
  await mkdir(join(outDir, "dom"), { recursive: true });

  const result = await page.evaluate(({ props }) => {
    // assign a stable id to every visible element
    let counter = 0;
    const out: Record<string, Record<string, string>> = {};

    // skip script/style/meta/etc — only walk visual nodes
    const SKIP = new Set(["SCRIPT", "STYLE", "META", "LINK", "HEAD", "TITLE", "BR", "NOSCRIPT"]);

    function walk(el: Element) {
      if (SKIP.has(el.tagName)) return;
      const id = String(counter++);
      el.setAttribute("data-cs-id", id);
      const cs = window.getComputedStyle(el);
      const styles: Record<string, string> = {};
      for (const prop of props) {
        const v = cs.getPropertyValue(prop);
        if (v && v !== "normal" && v !== "auto" && v !== "none" && v !== "0px") {
          styles[prop] = v;
        }
      }
      // also pull bounding box — useful for sanity checks + as fallback for layout
      const r = el.getBoundingClientRect();
      if (r.width > 0 || r.height > 0) {
        styles.__bbox = `${Math.round(r.width)}x${Math.round(r.height)}`;
      }
      if (Object.keys(styles).length > 0) {
        out[id] = styles;
      }
      for (const child of Array.from(el.children)) walk(child);
    }

    if (document.body) walk(document.body);
    return { count: counter, styles: out };
  }, { props: VISUAL_PROPS });

  const path = join(outDir, "dom", "computed-styles.json");
  await writeFile(path, JSON.stringify(result.styles, null, 0), "utf8");
  console.log(`  🎨 computed-styles.json (${result.count} nodes, ${Object.keys(result.styles).length} with styles)`);
  return path;
}
