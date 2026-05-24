// motion-probe — rAF-sampled transform/opacity capture across scroll range.
// scrolls the page in fixed increments, captures per-element computed transform
// + opacity at each step. output: per-element keyframe timeline keyed on
// scrollY, ready to replay in GSAP timelines.
//
// usage: bun motion-probe.mjs <url> [interval=40] [outFile=/tmp/probe.json]

import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const url = process.argv[2] || "https://thingsagency.framer.website/?via=daniel-37";
const interval = Number(process.argv[3] || 40);
const out = process.argv[4] || "/tmp/motion-probe.json";

// MUST be headed: motion/react + GSAP reveals are rAF/IntersectionObserver-driven
// and frequently don't run under headless, so a headless capture finds 0 motion.
const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

await page.goto(url, { waitUntil: "load" });
await page.waitForTimeout(2500);

// register a stable id on every interesting element so we can track them across scrolls
await page.evaluate(() => {
  let i = 0;
  const all = document.querySelectorAll("*");
  all.forEach((el) => {
    if (!(el instanceof HTMLElement)) return;
    const r = el.getBoundingClientRect();
    if (r.width < 30 || r.height < 12) return;
    const cs = getComputedStyle(el);
    const hasMotion =
      cs.transform !== "none" ||
      Number(cs.opacity) < 1 ||
      el.dataset.framerName ||
      el.tagName === "IMG" ||
      el.children.length === 0; // leaf
    if (!hasMotion) return;
    el.setAttribute("data-mp", String(i++));
  });
});

const maxScroll = await page.evaluate(
  () => document.documentElement.scrollHeight - window.innerHeight
);
console.log(`maxScroll = ${maxScroll}px, interval = ${interval}px`);

// roster: element id → metadata
const roster = await page.evaluate(() => {
  const out = {};
  document.querySelectorAll("[data-mp]").forEach((el) => {
    const id = el.getAttribute("data-mp");
    const r = el.getBoundingClientRect();
    out[id] = {
      tag: el.tagName.toLowerCase(),
      framerName: el.dataset?.framerName ?? null,
      text: (el.textContent || "").trim().slice(0, 60),
      initialBox: {
        x: Math.round(r.x),
        y: Math.round(r.y + window.scrollY),
        w: Math.round(r.width),
        h: Math.round(r.height),
      },
    };
  });
  return out;
});

// timeline: scrollY → { id → { transform, opacity, top } }
const timeline = [];
for (let y = 0; y <= maxScroll; y += interval) {
  await page.evaluate((y) => window.scrollTo({ top: y, behavior: "instant" }), y);
  // wait two RAFs for motion lib to settle
  await page.evaluate(
    () =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  );
  const states = await page.evaluate(() => {
    const out = {};
    document.querySelectorAll("[data-mp]").forEach((el) => {
      const id = el.getAttribute("data-mp");
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      out[id] = {
        t: cs.transform === "none" ? null : cs.transform,
        o: parseFloat(cs.opacity),
        vy: Math.round(r.top), // viewport-relative top (where it sits in viewport)
      };
    });
    return out;
  });
  timeline.push({ scrollY: y, states });
  if (y % 400 === 0) console.log(`  sampled scrollY=${y}`);
}

// post-process: for each element, find which scroll ranges had varying transform/opacity
// → output a compact per-element keyframe list
const elementKeyframes = {};
for (const id of Object.keys(roster)) {
  const frames = timeline.map((s) => ({ y: s.scrollY, ...s.states[id] }));
  // skip elements with no motion
  const transforms = new Set(frames.map((f) => f.t));
  const opacities = new Set(frames.map((f) => f.o));
  if (transforms.size <= 1 && opacities.size <= 1) continue;
  // compress: only keep keyframes where transform OR opacity CHANGED
  const compressed = [];
  let last = null;
  for (const f of frames) {
    if (
      !last ||
      f.t !== last.t ||
      Math.abs((f.o ?? 1) - (last.o ?? 1)) > 0.005 ||
      Math.abs(f.vy - last.vy) > 8
    ) {
      compressed.push(f);
      last = f;
    }
  }
  if (compressed.length < 2) continue;
  elementKeyframes[id] = {
    meta: roster[id],
    keyframes: compressed,
  };
}

const summary = {
  url,
  capturedAt: new Date().toISOString(),
  viewport: { w: 1440, h: 900 },
  maxScroll,
  interval,
  totalSamples: timeline.length,
  elementsWithMotion: Object.keys(elementKeyframes).length,
};

writeFileSync(out, JSON.stringify({ summary, elementKeyframes }, null, 2));
console.log(`\nwrote ${out}`);
console.log(`  → ${summary.elementsWithMotion} elements with motion`);
console.log(`  → ${summary.totalSamples} scroll samples`);

await browser.close();
