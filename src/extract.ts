#!/usr/bin/env bun
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  autoScroll,
  takeFullScreenshots,
  dumpFullDOM,
  createAssetCollector,
} from './static.ts';
import {
  detectStack,
  scanComputedTransitions,
  captureCDPAnimations,
  writeMotionArtifacts,
} from './motion.ts';
import { extractTokens, writeTokenArtifacts } from './tokens.ts';
import { detectSections, captureSectionScreenshots } from './sections.ts';
import { writeRebuildMd, writeStackMd } from './rebuild.ts';
import type { ExtractOptions, Viewport, Meta } from './types.ts';

const DEFAULT_VIEWPORTS: Viewport[] = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 390, height: 844 },
];

function parseArgs(argv: string[]): ExtractOptions {
  const args = argv.slice(2);
  const url = args.find((a) => !a.startsWith('--'));
  if (!url) {
    console.error('Usage: extract-site <url> [--out <dir>] [--name <slug>] [--headless]');
    process.exit(1);
  }
  const get = (k: string) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const has = (k: string) => args.includes(`--${k}`);
  const host = new URL(url).hostname.replace(/^www\./, '');
  const name = get('name') ?? host.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const outRoot = resolve(process.cwd(), get('out') ?? 'reference');
  return {
    url,
    name,
    outDir: join(outRoot, name),
    headless: has('headless'),
    viewports: DEFAULT_VIEWPORTS,
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  const t0 = Date.now();
  console.log(`\n🎯 extract-site → ${opts.url}`);
  console.log(`   out: ${opts.outDir}`);
  console.log(`   headed: ${!opts.headless}\n`);

  await mkdir(opts.outDir, { recursive: true });
  await mkdir(join(opts.outDir, 'stack'), { recursive: true });

  const browser = await chromium.launch({
    headless: opts.headless,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  const assets = createAssetCollector(page, opts.outDir);

  console.log('▶ phase 1: navigate + scroll');
  await page.goto(opts.url, { waitUntil: 'networkidle', timeout: 60000 }).catch(async () => {
    console.warn('  ⚠️  networkidle timeout, falling back to load');
    await page.goto(opts.url, { waitUntil: 'load', timeout: 60000 });
  });
  await page.waitForTimeout(2000);
  await autoScroll(page);

  const pageTitle = await page.title();
  console.log(`  📄 "${pageTitle}"`);

  console.log('\n▶ phase 2: detect stack');
  const stack = await detectStack(page);
  console.log(`  framework=${stack.framework} framer=${stack.framer} motion=${stack.framerMotion} lenis=${stack.lenis} gsap=${stack.gsap}`);

  console.log('\n▶ phase 3: dom dump + screenshots');
  await dumpFullDOM(page, opts.outDir);
  await takeFullScreenshots(page, opts.outDir, opts.viewports);
  // reset to desktop for everything else
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(400);

  console.log('\n▶ phase 4: design tokens');
  const tokens = await extractTokens(page);
  await writeTokenArtifacts(opts.outDir, tokens);

  console.log('\n▶ phase 5: motion (CDP + computed scan)');
  const cdp = await context.newCDPSession(page);
  const cdpAnimations = await captureCDPAnimations(cdp, page, 12000);
  const computed = await scanComputedTransitions(page);
  await writeMotionArtifacts(opts.outDir, computed, cdpAnimations, stack);

  console.log('\n▶ phase 6: section detection + per-section captures');
  const sections = await detectSections(page);
  await captureSectionScreenshots(page, opts.outDir, sections, opts.viewports);

  console.log('\n▶ phase 7: finalize artifacts');
  await assets.finalize();
  await writeStackMd(opts.outDir, stack);

  const meta: Meta = {
    url: opts.url,
    capturedAt: new Date().toISOString(),
    name: opts.name,
    viewports: opts.viewports,
    pageTitle,
    stack,
    sectionCount: sections.length,
    animationCount: computed.length + cdpAnimations.length,
    assetCount: assets.manifest.length,
  };
  await writeFile(join(opts.outDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  await writeRebuildMd(opts.outDir, meta, sections);

  await context.close();
  await browser.close();

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n✅ done in ${elapsed}s → ${opts.outDir}`);
  console.log(`   open: ${join(opts.outDir, 'REBUILD.md')}`);
}

main().catch((e) => {
  console.error('💥 extract failed:', e);
  process.exit(1);
});
