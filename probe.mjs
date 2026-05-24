// probe.mjs — numerical CSS parity probe (the fidelity oracle for a rebuild)
//
// Captures bounding rect + ~30 computed style props for a matched set of
// elements on TWO urls (the live original and your local rebuild), pairs them
// in DOM order per selector group, and writes a human-readable css-diff.md plus
// a machine-readable css-diff.json. This is what you iterate against until the
// diffs collapse to single digits. No mirror required — it just needs two
// reachable urls.
//
// usage:
//   bun probe.mjs <originalUrl> <rebuildUrl> [outDir=.]
// example:
//   bun probe.mjs https://moment.framer.photos http://localhost:5173 ./reference/moment
//
// output: <outDir>/css-diff.md, <outDir>/css-diff.json

import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const originalUrl = process.argv[2];
const rebuildUrl = process.argv[3];
const outDir = process.argv[4] || '.';

if (!originalUrl || !rebuildUrl) {
  console.error('usage: bun probe.mjs <originalUrl> <rebuildUrl> [outDir=.]');
  process.exit(1);
}

// the props that actually matter for visual fidelity. fontFamily is included but
// treated leniently in the diff (a resolved `sans-serif` vs a named family with
// the same metric grid is visually identical).
const PROPS = [
  'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
  'fontStyle', 'textAlign', 'textTransform', 'color', 'backgroundColor',
  'opacity', 'transform', 'transformOrigin', 'transitionTimingFunction',
  'transitionDuration', 'transitionDelay', 'borderRadius', 'boxShadow',
  'display', 'flexDirection', 'justifyContent', 'alignItems', 'gap',
  'padding', 'margin', 'width', 'height', 'maxWidth', 'zIndex', 'filter',
];

// selector groups. h1/h2/h3/p/nav cover typographic + structural parity; the
// framer-name groups catch the authored layout blocks. extend per target.
const SELECTORS = ['h1', 'h2', 'h3', 'p', 'nav', '[data-framer-name]'];

async function capture(url) {
  // MUST be headed: Framer motion libraries (motion/react, GSAP) gate on rAF +
  // IntersectionObserver + real layout/compositing, and hover/mouse events need a
  // real rendering context. Headless silently skips entry/hover/scroll motion, so
  // a headless probe reads wrong resting states and reports false diffs.
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  // settle: let fonts + entry motion finish so we read resting state
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 800)));

  const data = await page.evaluate(({ selectors, props }) => {
    const out = {};
    for (const sel of selectors) {
      const els = Array.from(document.querySelectorAll(sel));
      out[sel] = els.slice(0, 50).map((el) => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const style = {};
        for (const p of props) style[p] = cs[p];
        return {
          text: (el.textContent || '').trim().slice(0, 40),
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          framerName: el.getAttribute('data-framer-name') || null,
          style,
        };
      });
    }
    return out;
  }, { selectors: SELECTORS, props: PROPS });

  await browser.close();
  return data;
}

function diffPair(a, b) {
  const diffs = [];
  // rect (allow 1px rounding slack)
  for (const k of ['x', 'y', 'w', 'h']) {
    if (Math.abs(a.rect[k] - b.rect[k]) > 1) diffs.push({ prop: `rect.${k}`, original: a.rect[k], rebuild: b.rect[k] });
  }
  for (const p of PROPS) {
    if (a.style[p] !== b.style[p]) {
      // fontFamily is lenient: only flag if neither resolves to a generic
      if (p === 'fontFamily') {
        const generic = (v) => /^(sans-serif|serif|monospace)$/i.test((v || '').trim());
        if (generic(a.style[p]) || generic(b.style[p])) continue;
      }
      diffs.push({ prop: p, original: a.style[p], rebuild: b.style[p] });
    }
  }
  return diffs;
}

const [orig, rebuilt] = await Promise.all([capture(originalUrl), capture(rebuildUrl)]);

let totalDiffs = 0;
let totalPaired = 0;
let fullyMatching = 0;
const report = [];

for (const sel of SELECTORS) {
  const A = orig[sel] || [];
  const B = rebuilt[sel] || [];
  const n = Math.min(A.length, B.length);
  if (A.length !== B.length) {
    report.push({ selector: sel, countMismatch: { original: A.length, rebuild: B.length } });
  }
  for (let i = 0; i < n; i++) {
    totalPaired++;
    const d = diffPair(A[i], B[i]);
    totalDiffs += d.length;
    if (d.length === 0) fullyMatching++;
    else report.push({ selector: sel, index: i, text: A[i].text, framerName: A[i].framerName, diffs: d });
  }
}

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'css-diff.json'), JSON.stringify({ originalUrl, rebuildUrl, totalDiffs, totalPaired, fullyMatching, report }, null, 2), 'utf8');

const md = [
  `# CSS parity diff`,
  ``,
  `- original: ${originalUrl}`,
  `- rebuild:  ${rebuildUrl}`,
  `- **${totalDiffs} total style diffs across ${totalPaired} paired elements; ${fullyMatching} fully matching**`,
  ``,
  ...report.flatMap((r) => {
    if (r.countMismatch) return [`## \`${r.selector}\` — COUNT MISMATCH: original ${r.countMismatch.original} vs rebuild ${r.countMismatch.rebuild}`, ``];
    const head = `## \`${r.selector}\`[${r.index}] ${r.framerName ? `(${r.framerName}) ` : ''}— "${r.text}"`;
    const rows = r.diffs.map((d) => `- \`${d.prop}\`: original \`${d.original}\` → rebuild \`${d.rebuild}\``);
    return [head, ...rows, ``];
  }),
].join('\n');

await writeFile(join(outDir, 'css-diff.md'), md, 'utf8');
console.log(`${totalDiffs} diffs across ${totalPaired} paired (${fullyMatching} fully matching) → ${join(outDir, 'css-diff.md')}`);
