#!/usr/bin/env bun
// `extract-site rebuild <reference-dir> [--out <project-dir>] [--name <slug>]`
//
// transpiles an extract-site reference into a fully editable react+vite project.
// each top-level section becomes its own component (editable html literal +
// framer-motion entry animation). framer's css is preserved verbatim so layouts
// stay pixel-faithful. user can reorder, remove, replace, or add sections by
// editing real react code.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(__dirname, "..");
const TPL_DIR   = path.join(SKILL_DIR, "templates", "rebuild");

interface Args {
  reference: string;
  out: string;
  name: string;
  sourceMirror?: string;
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(3); // strip [bun, script, "rebuild"]
  const positional = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
  const reference = positional[0];
  if (!reference) {
    console.error("Usage: extract-site rebuild <reference-dir> [--out <project-dir>] [--name <slug>] [--source-mirror <path>]");
    process.exit(1);
  }
  const get = (k: string) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const refResolved = path.resolve(process.cwd(), reference);
  const fallbackName = path.basename(refResolved).replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "rebuild";
  const name = get("name") ?? fallbackName;
  const out  = path.resolve(process.cwd(), get("out") ?? `${fallbackName}-rebuild`);
  const sourceMirrorRaw = get("source-mirror");
  const sourceMirror = sourceMirrorRaw ? path.resolve(process.cwd(), sourceMirrorRaw) : undefined;
  return { reference: refResolved, out, name, sourceMirror };
}

function readJsonSafe(p: string): unknown {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

// ─── asset path rewriter ─────────────────────────────────────────────────
// extract-site saves assets with hash prefixes like "ba885af0-original.png" to
// dedupe + correct mistyped extensions (e.g. .png that's actually avif). the
// html and css still reference the ORIGINAL filenames. this map lets us rewrite
// every reference (img src, srcset, css url()) to the actual saved path.

interface ManifestEntry {
  originalUrl: string;
  localPath: string;
  type: string;
  ok: boolean;
}

interface AssetRewriter {
  rewrite(input: string): string;
}

function buildAssetRewriter(reference: string): AssetRewriter {
  const manifestPath = path.join(reference, "assets", "manifest.json");
  const manifest = readJsonSafe(manifestPath) as ManifestEntry[] | null;
  if (!manifest || !Array.isArray(manifest)) {
    return { rewrite: (s) => s };
  }

  // basename(originalUrl) → public-relative path like "/images/HASH-NAME.ext"
  const map = new Map<string, string>();
  for (const entry of manifest) {
    if (!entry?.ok) continue;
    const origBase = path.basename(entry.originalUrl.split("?")[0]);
    const localBase = path.basename(entry.localPath);
    const sub = entry.type === "font" ? "fonts" : entry.type === "video" ? "videos" : entry.type === "audio" ? "audio" : "images";
    map.set(origBase, `/${sub}/${localBase}`);
  }

  // sort longer keys first so we never partially shadow a longer match
  const keys = Array.from(map.keys()).sort((a, b) => b.length - a.length);

  return {
    rewrite(input) {
      let out = input;
      for (const k of keys) {
        if (!out.includes(k)) continue;
        const escapedBase = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        // consume any optional URL prefix path (./__mirror/.../images/) along
        // with the basename so we don't end up with `/images//images/...`
        // doubled paths. covers: bare basename, ./path/X, /path/X, full URL.
        const re = new RegExp(
          `(?<=["'(\\s])(?:[^"'(\\s)]*\\/)?${escapedBase}(?=$|[?"'\\s),])`,
          "g",
        );
        out = out.replace(re, map.get(k)!);
      }
      // any leftover `./__mirror/...` paths fall through to the source-mirror
      // copy at /public/__mirror/... (see cmd-rebuild's --source-mirror flag).
      out = out.replace(/(["'(])\.?\/?__mirror\//g, '$1/__mirror/');
      return out;
    },
  };
}

// ─── computed-styles merge ────────────────────────────────────────────────
// reads dom/computed-styles.json + walks each section's html with cheerio,
// merging the captured `getComputedStyle()` values onto every element via
// inline `style="..."`. this is what gives the rebuild visual fidelity
// without needing framer's runtime to compute layout dynamically.

type ComputedStylesMap = Record<string, Record<string, string>>;

function loadComputedStyles(reference: string): ComputedStylesMap | null {
  return readJsonSafe(path.join(reference, "dom", "computed-styles.json")) as ComputedStylesMap | null;
}

function mergeStyleString(existing: string | undefined, computed: Record<string, string>): string {
  // existing inline styles are AUTHOR-INTENT (framer set them deliberately).
  // computed styles are FALLBACK for properties the author didn't inline.
  // strategy: build the final declaration list with computed first, then existing
  // overrides last so they win cascade order.
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const [prop, val] of Object.entries(computed)) {
    if (prop.startsWith("__")) continue; // skip metadata like __bbox
    seen.add(prop);
    parts.push(`${prop}:${val}`);
  }
  if (existing) {
    for (const decl of existing.split(";")) {
      const m = decl.match(/^\s*([\w-]+)\s*:\s*(.+?)\s*$/);
      if (!m) continue;
      const prop = m[1].toLowerCase();
      if (seen.has(prop)) {
        // override: replace the earlier computed value
        const idx = parts.findIndex((p) => p.startsWith(prop + ":"));
        if (idx >= 0) parts[idx] = `${prop}:${m[2]}`;
      } else {
        parts.push(`${prop}:${m[2]}`);
      }
    }
  }
  return parts.join(";");
}

function applyComputedStyles(html: string, styles: ComputedStylesMap | null): string {
  if (!styles) return html;
  const $ = cheerio.load(html, { decodeEntities: false }, false);
  $("[data-cs-id]").each((_, el) => {
    const id = $(el).attr("data-cs-id");
    if (!id) return;
    const cs = styles[id];
    if (!cs) return;
    const merged = mergeStyleString($(el).attr("style"), cs);
    if (merged) $(el).attr("style", merged);
  });
  return $.html();
}

// ─── post-processing for section html ────────────────────────────────────
// framer's initial state encoded inline (opacity:0.001, transform:translateY)
// keeps elements invisible until framer's runtime animates them in. without
// that runtime we'd see a blank page. so: snap initial opacity to 1 and
// strip the initial transform so elements appear immediately. (framer-motion
// will still drive section-level entry animations on top of this.)

function neutralizeFramerInitialState(html: string): string {
  return html
    // opacity: 0.001 → opacity: 1
    .replace(/opacity\s*:\s*0\.0+1\s*;?/g, "opacity: 1;")
    // will-change: transform with opacity:0.001 friend — also strip the matching
    // initial transform so the element doesn't sit translated/scaled forever
    .replace(/transform\s*:\s*translate[XY]?\(-?\d+(?:\.\d+)?(?:px|%)\)(?:\s+(?:rotate|scale|translate)\([^)]+\))?\s*;?/g, (m) => {
      // only strip if it looks like an initial-state translate (Y±, X±, or scale 0.x).
      // if it's a deliberate transform (rotate(90deg) etc), keep it.
      if (/translate(?:Y|X)?\(-?\d+px\)/.test(m) || /scale\(0\./.test(m)) return "";
      return m;
    });
}

// ─── css extraction ───────────────────────────────────────────────────────
// pull every <style>…</style> from full.html into a single concatenated string.
// preserves the exact rules framer ships (custom properties, font-face,
// .framer-* class definitions, layout grid rules, etc).

function extractStylesFromHtml(html: string): string {
  const styles: string[] = [];
  const re = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    styles.push(m[1]);
  }
  // also pull any <link rel="stylesheet" href="..."> hrefs into a comment so the
  // user can manually inline them if visuals are off.
  const linkRe = /<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/gi;
  const links: string[] = [];
  while ((m = linkRe.exec(html)) !== null) {
    links.push(m[1]);
  }

  const banner = `/* framer-baseline.css — extracted verbatim from the source mirror.
   contains every <style> block from the original page in cascade order.
   do NOT hand-edit; if you need overrides, put them in app.css. */\n\n`;
  const linkComment = links.length
    ? `/* the source page also linked these external stylesheets:\n${links.map(l => `   - ${l}`).join("\n")}\n   if visuals are off, manually inline their contents below. */\n\n`
    : "";
  return banner + linkComment + styles.join("\n\n/* ─── next <style> block ─── */\n\n");
}

// ─── section parsing ──────────────────────────────────────────────────────
// each section file from extract is a single-line html subtree. pull off the
// outer <section> tag's data-framer-name (or fall back to filename).

function parseSection(html: string, fallbackName: string): { framerName: string; html: string } {
  const m = /<(section|div|main|article|aside)\b[^>]*\bdata-framer-name=["']([^"']+)["']/.exec(html);
  return {
    framerName: m?.[2] ?? fallbackName,
    html,
  };
}

function toPascalCase(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("") || "Section";
}

// ─── per-section motion lookup ────────────────────────────────────────────
// extract-site's animations.json has every animated element with:
//   { selector, classification, sectionSlug, cssDuration, cssTimingFunction, ... }
// we pick the most-eventful animation per section to drive the entry timing.
// fallback: framer-tier defaults (spring 0.8s bounce 0.3) — these match what
// framer ships out of the box and look identical to the original most of the time.

interface AnimEntry {
  selector?: string;
  classification?: string[];
  sectionSlug?: string;
  cssDuration?: string;
  cssTimingFunction?: string;
  cssDelay?: string;
}

interface MotionSpec {
  duration?: number;
  bounce?: number;
  delay?: number;
  ease?: number[];
}

function parseDurationToSeconds(s?: string): number | undefined {
  if (!s) return undefined;
  const m = /^([\d.]+)(ms|s)?$/.exec(s.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  return m[2] === "ms" ? n / 1000 : n;
}

function pickSectionMotion(animations: { computed?: AnimEntry[] } | null, sectionSlug: string): MotionSpec {
  if (!animations?.computed) return {};
  const entries = animations.computed.filter((a) => a.sectionSlug === sectionSlug);
  // the most informative entries are ones with non-zero duration
  const meaningful = entries.find((a) => {
    const d = parseDurationToSeconds(a.cssDuration);
    return d != null && d > 0;
  });
  if (!meaningful) return {};
  return {
    duration: parseDurationToSeconds(meaningful.cssDuration),
    delay: parseDurationToSeconds(meaningful.cssDelay),
  };
}

// ─── section component generator ──────────────────────────────────────────

function generateSectionComponent(opts: {
  componentName: string;
  framerName: string;
  html: string;
  motion: MotionSpec;
}): string {
  const { componentName, framerName, html, motion } = opts;
  // backticks inside html need escaping for the template literal
  const safeHtml = html.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");
  const transitionFields: string[] = ["type: \"spring\""];
  transitionFields.push(`duration: ${motion.duration ?? 0.8}`);
  transitionFields.push(`bounce: ${motion.bounce ?? 0.3}`);
  if (motion.delay && motion.delay > 0) transitionFields.push(`delay: ${motion.delay}`);
  const transition = `{ ${transitionFields.join(", ")} }`;

  return `// ${componentName}.tsx
// auto-generated from section "${framerName}" by extract-site rebuild.
// edit the HTML literal below to change content/layout — hot reload picks it up.
// reorder/remove this section by editing src/App.tsx.

import { Section } from "../lib/Section";

const HTML = \`${safeHtml}\`;

export function ${componentName}() {
  return (
    <Section
      framerName="${framerName.replaceAll('"', '\\"')}"
      html={HTML}
      transition={${transition}}
    />
  );
}
`;
}

// ─── App.tsx generator ────────────────────────────────────────────────────

function generateApp(sections: { componentName: string; framerName: string; importPath: string }[]): string {
  const imports = sections.map((s) => `import { ${s.componentName} } from "${s.importPath}";`).join("\n");
  const usage   = sections.map((s) => `      <${s.componentName} />`).join("\n");

  return `// App.tsx — composes sections in order.
// reorder by moving lines around. remove by deleting. add new ones by writing
// a component in src/sections/ and importing it here.

${imports}

export function App() {
  return (
    <main>
${usage}
    </main>
  );
}
`;
}

// ─── asset copy ──────────────────────────────────────────────────────────

function copyDirContents(src: string, dst: string) {
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dst, { recursive: true });
  let n = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const sp = path.join(src, entry.name);
    const dp = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      n += copyDirContents(sp, dp);
    } else {
      fs.copyFileSync(sp, dp);
      n++;
    }
  }
  return n;
}

// ─── template copy with marker interpolation ──────────────────────────────

function copyTemplate(src: string, dst: string, replacements: Record<string, string>) {
  let content = fs.readFileSync(src, "utf8");
  for (const [k, v] of Object.entries(replacements)) {
    content = content.replaceAll(k, v);
  }
  fs.writeFileSync(dst, content);
}

// ─── main ────────────────────────────────────────────────────────────────

async function main() {
  const { reference, out, name, sourceMirror } = parseArgs(process.argv);

  if (!fs.existsSync(reference)) {
    console.error(`[err] reference dir not found: ${reference}`);
    process.exit(1);
  }
  if (fs.existsSync(out) && fs.readdirSync(out).length > 0) {
    console.error(`[err] output dir is not empty: ${out}`);
    console.error(`      delete it first, or pass --out <other-dir>`);
    process.exit(1);
  }

  const meta = readJsonSafe(path.join(reference, "meta.json")) as { url?: string; pageTitle?: string } | null;
  const refUrl = meta?.url ?? "<reference url>";

  console.log(`\n🔧 extract-site rebuild`);
  console.log(`   reference: ${reference}`);
  console.log(`   out:       ${out}`);
  console.log(`   name:      ${name}`);
  console.log(`   source:    ${refUrl}\n`);

  fs.mkdirSync(out, { recursive: true });
  fs.mkdirSync(path.join(out, "src", "sections"), { recursive: true });
  fs.mkdirSync(path.join(out, "src", "lib"), { recursive: true });
  fs.mkdirSync(path.join(out, "public"), { recursive: true });

  // 0. build the asset path rewriter (manifest-driven)
  const rewriter = buildAssetRewriter(reference);

  // 1. extract framer's css from full.html and write to src/framer-baseline.css
  const fullHtmlPath = path.join(reference, "dom", "full.html");
  if (!fs.existsSync(fullHtmlPath)) {
    console.error(`[err] missing reference/dom/full.html. extract-site reference looks incomplete.`);
    process.exit(1);
  }
  const fullHtml = fs.readFileSync(fullHtmlPath, "utf8");
  const framerCssRaw = extractStylesFromHtml(fullHtml);
  const framerCss = rewriter.rewrite(framerCssRaw);
  fs.writeFileSync(path.join(out, "src", "framer-baseline.css"), framerCss);
  console.log(`   ✓ framer-baseline.css extracted (${(framerCss.length / 1024).toFixed(1)} kB, paths rewritten)`);

  // 2. find sections
  const sectionsDir = path.join(reference, "dom", "sections");
  if (!fs.existsSync(sectionsDir)) {
    console.error(`[err] missing reference/dom/sections/. extract-site reference looks incomplete.`);
    process.exit(1);
  }
  const sectionFiles = fs.readdirSync(sectionsDir)
    .filter((f) => f.endsWith(".html"))
    .sort(); // filename prefix gives order

  const animations = readJsonSafe(path.join(reference, "motion", "animations.json")) as { computed?: AnimEntry[] } | null;

  // 2b. computed-styles: read once, applied per section below
  const computedStyles = loadComputedStyles(reference);
  if (computedStyles) {
    console.log(`   ✓ computed-styles.json loaded (${Object.keys(computedStyles).length} nodes)`);
  } else {
    console.warn(`   ⚠ no computed-styles.json — sections may not render visually (re-extract with v0.4+)`);
  }

  // 3. extract the full body html and prepare it for client-side rendering.
  // strategy: take the entire <body> innerHTML, strip framer scripts, apply
  // computed styles + asset rewrites. preserves the parent layout chain.
  const $body = cheerio.load(fullHtml, { decodeEntities: false });
  $body("script").remove();
  $body("noscript").remove();
  let bodyHtml = $body("body").html() ?? "";
  bodyHtml = rewriter.rewrite(bodyHtml);
  bodyHtml = applyComputedStyles(bodyHtml, computedStyles);
  bodyHtml = neutralizeFramerInitialState(bodyHtml);

  // 4. SPLIT into per-section files. find every top-level data-framer-name
  // element inside <main>, extract its outerHTML to its own file, replace
  // with a template-literal interpolation marker. user can now edit any
  // section's html in isolation — hot reload picks it up via vite's HMR.
  const $page = cheerio.load(`<root>${bodyHtml}</root>`, { decodeEntities: false });
  const sectionInfos: { exportName: string; framerName: string; importPath: string; varName: string }[] = [];
  const usedExports = new Set<string>();
  let sectionIdx = 0;

  // identify sections: direct children of <main> with data-framer-name,
  // or top-level <section> elements anywhere
  const sectionSelectors = ["main > [data-framer-name]", "main section", "body > main > div[data-framer-name]"];
  const candidates: cheerio.Cheerio<any>[] = [];
  for (const sel of sectionSelectors) {
    $page(sel).each((_, el) => {
      const $el = $page(el);
      // skip if already inside another candidate (avoid nested duplicates)
      if (candidates.some((c) => c.find(el).length > 0)) return;
      candidates.push($el);
    });
  }

  for (const $section of candidates) {
    const framerName = $section.attr("data-framer-name") || `section-${sectionIdx}`;
    sectionIdx++;
    let baseExport = toPascalCase(framerName);
    if (!baseExport || /^\d/.test(baseExport)) baseExport = `Section${sectionIdx}`;
    let exportName = baseExport;
    while (usedExports.has(exportName)) exportName = `${baseExport}_${sectionIdx}`;
    usedExports.add(exportName);
    const varName = exportName.charAt(0).toLowerCase() + exportName.slice(1);
    const fileName = `${String(sectionIdx).padStart(2, "0")}-${exportName}`;
    const sectionHtml = $page.html($section as any) ?? "";

    const safeSectionHtml = sectionHtml
      .replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");
    const sectionTs = `// ${exportName}.ts — section "${framerName}"
// edit the HTML literal below. hot reload picks up changes.

export const ${varName} = \`${safeSectionHtml}\`;
`;
    fs.writeFileSync(path.join(out, "src", "sections", `${fileName}.ts`), sectionTs);

    // replace the section in the page tree with a unique marker we can swap
    // for a template-literal interpolation on serialization
    $section.replaceWith(`<!--SECTION:${varName}-->`);

    sectionInfos.push({ exportName, framerName, importPath: `./sections/${fileName}`, varName });
  }

  // re-serialize the page html with section markers
  let pageWithMarkers = $page("root").html() ?? bodyHtml;
  // turn the markers into template-literal interpolations
  for (const s of sectionInfos) {
    pageWithMarkers = pageWithMarkers.replaceAll(
      `<!--SECTION:${s.varName}-->`,
      `\${${s.varName}}`,
    );
  }
  const safePageHtml = pageWithMarkers
    .replaceAll("\\", "\\\\")
    .replaceAll("`", "\\`");
  // we DON'T escape ${} here because section interpolations need to fire

  const sectionImports = sectionInfos
    .map((s) => `import { ${s.varName} } from "${s.importPath}";`)
    .join("\n");

  const pageTsx = `// page.tsx — full-body render with per-section interpolation.
// the page shell (everything outside named sections) lives in this file.
// each section lives in its own file under src/sections/ — edit there for
// per-section changes, edit here for shell-level changes.
//
// sections (in render order):
${sectionInfos.map((s, i) => `//   ${i + 1}. "${s.framerName}" → src/sections/${path.basename(s.importPath)}.ts`).join("\n")}

${sectionImports}

const HTML = \`${safePageHtml}\`;

export function Page() {
  return <div dangerouslySetInnerHTML={{ __html: HTML }} />;
}
`;
  fs.writeFileSync(path.join(out, "src", "page.tsx"), pageTsx);
  console.log(`   ✓ page.tsx + ${sectionInfos.length} section file(s) generated`);

  // 5. App.tsx with framer-motion animation post-mount
  const appTsx = `// App.tsx — composes the rebuilt page + runs entry animations.
// edit src/page.tsx for the shell, src/sections/*.ts for individual sections.

import { useEffect } from "react";
import { animate } from "framer-motion";
import { Page } from "./page";
import { runEntryAnimations } from "./animations";

export function App() {
  useEffect(() => {
    runEntryAnimations(animate);
  }, []);
  return <Page />;
}
`;
  fs.writeFileSync(path.join(out, "src", "App.tsx"), appTsx);

  // 6. motion runtime — copy templates/rebuild/src/lib/motion-runtime.ts
  // (the framer-runtime port) and the captured motion JSONs into src/data/.
  // animations.ts becomes a thin shim that calls mountMotion(data).
  fs.cpSync(
    path.join(TPL_DIR, "src", "lib", "motion-runtime.ts"),
    path.join(out, "src", "lib", "motion-runtime.ts"),
  );
  fs.mkdirSync(path.join(out, "src", "data"), { recursive: true });
  const dataFiles: Array<{ name: string; stub: string }> = [
    { name: "appear-effects.json",  stub: '{"effects":[]}' },
    { name: "scroll-motion.json",   stub: '{"behaviors":[]}' },
    { name: "hover-thorough.json",  stub: '[]' },
    { name: "hover.json",           stub: '[]' },
  ];
  for (const { name, stub } of dataFiles) {
    const src = path.join(reference, "motion", name);
    if (fs.existsSync(src)) {
      fs.cpSync(src, path.join(out, "src", "data", name));
    } else {
      fs.writeFileSync(path.join(out, "src", "data", name), stub);
    }
  }

  type AppearEffect = {
    id: string;
    csId?: string | null;
    framerName: string | null;
    appearId: string | null;
    initial: Record<string, string>;
    rawStyle: string;
  };
  const appearEffects = readJsonSafe(path.join(reference, "motion", "appear-effects.json")) as
    | { effects: AppearEffect[] }
    | null;

  // animations.ts is now a thin shim: it imports the bundled appear/scroll
  // JSONs and hands them to motion-runtime.ts which does the IO + scroll wiring.
  // App.tsx still calls runEntryAnimations() — we keep the export name for
  // compat but the body just delegates to mountMotion().
  const scrollMotion = readJsonSafe(path.join(reference, "motion", "scroll-motion.json")) as
    | { behaviors: any[] }
    | null;
  const hoverThorough = readJsonSafe(path.join(reference, "motion", "hover-thorough.json")) as any[] | null;
  const hoverData = readJsonSafe(path.join(reference, "motion", "hover.json")) as any[] | null;
  // prefer hover-thorough (cs-id-keyed, page-wide) over hover.json (section-scoped)
  const hoverCount = (hoverThorough?.length || hoverData?.length) ?? 0;
  const animationsTs = `// animations.ts — boot the motion runtime over the rebuilt DOM.
// captured ${appearEffects?.effects?.length ?? 0} appear-effects + ${scrollMotion?.behaviors?.length ?? 0} scroll behaviors + ${hoverCount} hover effects.

import appear from "./data/appear-effects.json";
import scroll from "./data/scroll-motion.json";
import hoverThorough from "./data/hover-thorough.json";
import hoverLegacy from "./data/hover.json";
import { mountMotion } from "./lib/motion-runtime";

// hover-thorough is cs-id keyed (preferred). fall back to legacy hover.json
// if extract-site is older than v0.6 and didn't emit hover-thorough.
const hover = (hoverThorough as any[]).length > 0 ? hoverThorough : hoverLegacy;

export function runEntryAnimations(_animate?: unknown) {
  // _animate kept for backwards-compat with App.tsx — runtime owns animate now.
  mountMotion({ appear: appear as any, scroll: scroll as any, hover: hover as any });
}
`;
  fs.writeFileSync(path.join(out, "src", "animations.ts"), animationsTs);
  console.log(`   ✓ animations.ts → motion-runtime shim (${appearEffects?.effects?.length ?? 0} appear, ${scrollMotion?.behaviors?.length ?? 0} scroll)`);
  console.log(`   ✓ App.tsx composed`);

  // 5. copy assets — extract puts them in assets/{images,videos,fonts}/...
  let assetCount = 0;
  const assetSubdirs = ["images", "videos", "fonts", "audio"];
  for (const sub of assetSubdirs) {
    const src = path.join(reference, "assets", sub);
    if (fs.existsSync(src)) {
      assetCount += copyDirContents(src, path.join(out, "public", sub));
    }
  }
  console.log(`   ✓ ${assetCount} asset(s) copied to public/`);

  // 5b. (optional) copy the source mirror's __mirror tree as a fallback for
  // any asset extract-site didn't download (e.g. font subsets that never loaded
  // during scroll). without this you'll see broken font fallbacks.
  if (sourceMirror && fs.existsSync(sourceMirror)) {
    const mirrorSrc = fs.statSync(sourceMirror).isDirectory()
      ? sourceMirror
      : path.dirname(sourceMirror);
    const mirrorDst = path.join(out, "public", "__mirror");
    const n = copyDirContents(mirrorSrc, mirrorDst);
    console.log(`   ✓ ${n} mirror file(s) copied as fallback (--source-mirror)`);
  } else if (sourceMirror) {
    console.warn(`   ⚠ --source-mirror path not found: ${sourceMirror}`);
  }

  // 6. project files (template-driven)
  copyTemplate(path.join(TPL_DIR, "package.json"),  path.join(out, "package.json"),  { PROJECT_NAME: name });
  copyTemplate(path.join(TPL_DIR, "index.html"),    path.join(out, "index.html"),    { PROJECT_NAME: meta?.pageTitle || name });
  copyTemplate(path.join(TPL_DIR, "README.md"),     path.join(out, "README.md"),     { PROJECT_NAME: name, REFERENCE_URL: refUrl });
  fs.cpSync(path.join(TPL_DIR, "vite.config.ts"),   path.join(out, "vite.config.ts"));
  fs.cpSync(path.join(TPL_DIR, "tsconfig.json"),    path.join(out, "tsconfig.json"));
  fs.cpSync(path.join(TPL_DIR, ".gitignore"),       path.join(out, ".gitignore"));
  fs.cpSync(path.join(TPL_DIR, "src", "main.tsx"),  path.join(out, "src", "main.tsx"));
  fs.cpSync(path.join(TPL_DIR, "src", "app.css"),   path.join(out, "src", "app.css"));
  fs.cpSync(path.join(TPL_DIR, "src", "lib", "Section.tsx"), path.join(out, "src", "lib", "Section.tsx"));
  console.log(`   ✓ vite/react/ts/motion scaffolding written\n`);

  console.log(`✅ rebuilt at ${out}`);
  console.log(``);
  console.log(`next steps:`);
  console.log(`  cd ${path.relative(process.cwd(), out) || "."}`);
  console.log(`  bun install`);
  console.log(`  bun run dev      # → http://localhost:5173`);
  console.log(``);
  console.log(`each section is at src/sections/. edit the HTML literal in any of`);
  console.log(`them and the page hot-reloads. reorder via src/App.tsx.`);
}

main().catch((e) => {
  console.error("[err]", e.message);
  console.error(e.stack);
  process.exit(1);
});
