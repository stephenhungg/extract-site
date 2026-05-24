#!/usr/bin/env node
// customize.mjs — generic mirror-customization pipeline.
// scaffolded by `extract-site init`. edit freely for your project.
//
// pipeline:
//   1. load template-baseline.json (strings as shipped by the original mirror)
//   2. load config.json            (your overrides — pure user content)
//   3. load overrides.css          (your css patches)
//   4. fresh-copy mirror -> dist
//   5. walk text-y files, apply slot replacements
//   6. open dist/index.html with cheerio, run any custom html patches
//   7. inject overrides.css into <head>
//   8. report drift (per-slot hit counts)
//
// flags:
//   --strict    fail the build if any slot didn't match its expected count
//   --watch     re-run on changes to config / baseline / css / customize.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import chokidar from "chokidar";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const SRC  = path.join(ROOT, "mirror");
const DIST = path.join(ROOT, "dist");

const args   = new Set(process.argv.slice(2));
const STRICT = args.has("--strict");
const WATCH  = args.has("--watch");

// ─── helpers ──────────────────────────────────────────────────────────────

const rmrf = (p) => { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); };
const copyDir = (src, dst) => fs.cpSync(src, dst, { recursive: true });
function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}
const isTextFile = (p) => /\.(html?|mjs|js|css|json|txt|svg)$/i.test(p);
const escHtml    = (s) => String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
const readJson   = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

function hexToRgb(hex) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ─── slot registry — every replacement is a named slot with verification ───

class Slots {
  constructor() { this.slots = []; }
  add({ id, from, to, expectedMin = 1 }) {
    if (from == null || to == null || from === to) return;
    this.slots.push({ id, from: String(from), to: String(to), expectedMin, hits: 0 });
  }
  finalize() { this.slots.sort((a, b) => b.from.length - a.from.length); return this.slots; }
}

// ─── build slots from baseline + config ───────────────────────────────────
// edit this to match your site's slot layout. the patterns below are common
// for framer-style sites; add/remove freely.

function buildSlots(baseline, cfg) {
  const slots = new Slots();
  const push = (id, from, to, expectedMin) => slots.add({ id, from, to, expectedMin });

  // generic text slots — one entry per (baseline.x, config.x) pair.
  // walk the baseline and look up the matching config field by dotted path.
  walkPaths(baseline, [], (pathArr, baseValue) => {
    if (typeof baseValue !== "string") return;
    const cfgValue = lookupPath(cfg, pathArr);
    if (typeof cfgValue !== "string") return;
    push(pathArr.join("."), baseValue, cfgValue, 0);
  });

  // theme colors — replace hex AND rgb() forms (framer inlines both)
  if (cfg.theme?.colors && typeof cfg.theme.colors === "object") {
    for (const [from, to] of Object.entries(cfg.theme.colors)) {
      for (const v of new Set([from, from.toLowerCase(), from.toUpperCase()])) {
        push(`color.${from}`, v, to, 0);
      }
      const fromRgb = hexToRgb(from);
      const toRgb   = hexToRgb(to);
      if (fromRgb && toRgb) {
        const [fr, fg, fb] = fromRgb;
        const [tr, tg, tb] = toRgb;
        push(`color.${from}.rgb`,   `rgb(${fr},${fg},${fb})`,   `rgb(${tr},${tg},${tb})`,   0);
        push(`color.${from}.rgb.s`, `rgb(${fr}, ${fg}, ${fb})`, `rgb(${tr}, ${tg}, ${tb})`, 0);
      }
    }
  }

  // image filename rewrites
  if (cfg.images?.replacements) {
    for (const [from, to] of Object.entries(cfg.images.replacements)) {
      push(`image.${from}`, from, to, 0);
    }
  }

  return slots.finalize();
}

// recursively walk an object emitting (path, value) for every leaf
function walkPaths(obj, path_, fn) {
  if (obj === null || obj === undefined) return;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => walkPaths(v, [...path_, String(i)], fn));
    return;
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) walkPaths(v, [...path_, k], fn);
    return;
  }
  fn(path_, obj);
}
function lookupPath(obj, path_) {
  let cur = obj;
  for (const k of path_) {
    if (cur == null) return undefined;
    cur = cur[k];
  }
  return cur;
}

// ─── apply replacements over file contents ────────────────────────────────

function applySlots(content, slots) {
  let out = content;
  for (const slot of slots) {
    if (!out.includes(slot.from)) continue;
    const before = out;
    out = out.split(slot.from).join(slot.to);
    if (before !== out) {
      slot.hits += before.split(slot.from).length - 1;
    }
  }
  return out;
}

// ─── image copy ───────────────────────────────────────────────────────────

function copyConfiguredImages(cfg) {
  if (!cfg.images?.assets) return 0;
  let copied = 0;
  // the destination dirs your site references. for framer add the cdn mirror
  // path here too, e.g. path.join(DIST, "__mirror/https/framerusercontent.com/images").
  const dirs = (cfg.images.dirs ?? ["images"]).map((d) => path.join(DIST, d));
  for (const dir of dirs) fs.mkdirSync(dir, { recursive: true });
  for (const [fileName, sourceRel] of Object.entries(cfg.images.assets)) {
    const safeName = path.basename(fileName);
    const source   = path.resolve(ROOT, sourceRel);
    if (!source.startsWith(ROOT + path.sep)) {
      throw new Error(`custom image source must live inside this project: ${sourceRel}`);
    }
    if (!fs.existsSync(source)) {
      throw new Error(`custom image source not found: ${sourceRel}`);
    }
    for (const dir of dirs) {
      fs.copyFileSync(source, path.join(dir, safeName));
      copied++;
    }
  }
  return copied;
}

// ─── html surgery via cheerio ─────────────────────────────────────────────
// add project-specific patches here. examples below — edit for your site.

function patchHtml(html, cfg, css) {
  const $ = cheerio.load(html, { decodeEntities: false });

  // ─── PROJECT-SPECIFIC PATCHES START ───
  // example: turn a bare email anchor into a real mailto link
  // if (cfg.profile?.emailMailto && cfg.profile?.email) {
  //   $('a').filter((_, el) => $(el).text().trim() === cfg.profile.email && !$(el).attr('href'))
  //         .attr('href', `mailto:${cfg.profile.email}`);
  // }
  //
  // example: post-hydration injection script (avoids react #425 hydration mismatch)
  // const inject = `(function(){...})();`;
  // $('body').append(`<script data-source="customize.mjs">${inject}</script>`);
  // ─── PROJECT-SPECIFIC PATCHES END ───

  // inject css into <head>
  if (css.trim()) {
    $("head").append(`\n<style data-source="customize.mjs">\n${css}\n</style>\n`);
  }

  return $.html();
}

// ─── css with marker interpolation ────────────────────────────────────────

function loadCss(cfg) {
  const cssRaw = fs.readFileSync(path.join(ROOT, "overrides.css"), "utf8");
  return cssRaw
    .replaceAll("{{font-family}}", cfg.theme?.fontFamily ?? "inherit")
    .replaceAll("{{text-transform}}", cfg.theme?.textTransform ?? "none");
}

// ─── strict-mode verification ─────────────────────────────────────────────

function reportSlots(slots) {
  const drift = slots.filter((s) => s.hits < s.expectedMin);
  const fired = slots.filter((s) => s.hits > 0);
  const totalHits = slots.reduce((n, s) => n + s.hits, 0);
  console.log(`  slots:          ${slots.length}`);
  console.log(`  fired:          ${fired.length}`);
  console.log(`  total hits:     ${totalHits}`);
  if (drift.length === 0) {
    console.log(`  drift:          none ✓`);
    return true;
  }
  console.warn(`  drift:          ${drift.length} slot(s) under expected count`);
  for (const s of drift) {
    const t = s.from.length > 60 ? s.from.slice(0, 59) + "…" : s.from;
    console.warn(`    - ${s.id}: hits=${s.hits} expectedMin=${s.expectedMin}  from="${t}"`);
  }
  return false;
}

// ─── one full build pass ──────────────────────────────────────────────────

function build() {
  if (!fs.existsSync(SRC)) {
    console.error("[err] mirror/ not found. point this project at an extracted reference.");
    process.exit(1);
  }
  const baseline = readJson(path.join(ROOT, "template-baseline.json"));
  const cfg      = readJson(path.join(ROOT, "config.json"));
  const slots    = buildSlots(baseline, cfg);
  const css      = loadCss(cfg);

  console.log("customize.mjs");
  console.log("  src:           ", SRC);
  console.log("  dist:          ", DIST);

  rmrf(DIST);
  copyDir(SRC, DIST);
  const imagesCopied = copyConfiguredImages(cfg);

  let touched = 0;
  for (const f of walk(DIST)) {
    if (!isTextFile(f)) continue;
    const before = fs.readFileSync(f, "utf8");
    let after = applySlots(before, slots);
    if (f.endsWith(path.sep + "index.html")) after = patchHtml(after, cfg, css);
    if (after !== before) { fs.writeFileSync(f, after); touched++; }
  }
  console.log(`  files modified: ${touched}`);
  console.log(`  custom images:  ${imagesCopied}`);
  const clean = reportSlots(slots);
  if (STRICT && !clean) {
    console.error("\n[err] --strict: aborting due to slot drift above.");
    process.exit(2);
  }
  console.log("\ndone.");
}

// ─── watch mode ───────────────────────────────────────────────────────────

function watch() {
  const targets = [
    path.join(ROOT, "config.json"),
    path.join(ROOT, "template-baseline.json"),
    path.join(ROOT, "overrides.css"),
    path.join(ROOT, "customize.mjs"),
  ];
  console.log("watch mode — building on changes to:");
  for (const t of targets) console.log("  -", path.relative(ROOT, t));
  const run = () => { try { build(); } catch (e) { console.error("\n[build error]", e.message); } };
  run();
  let timer;
  chokidar.watch(targets, { ignoreInitial: true }).on("all", (event, p) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      console.log(`\n[change] ${event} ${path.relative(ROOT, p)}`);
      run();
    }, 80);
  });
}

WATCH ? watch() : build();
