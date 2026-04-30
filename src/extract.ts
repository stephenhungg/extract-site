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
import { sampledScrollCapture } from './sampler.ts';
import {
  detectStack,
  scanComputedTransitions,
  captureCDPAnimations,
  resolveCDPAnimationNodes,
  linkAnimationsToSections,
  classifyAnimatedElement,
  classifyCDPAnimation,
  tagStaggerGroups,
  tagCDPStaggerGroups,
  detectCharStagger,
  summarizeSectionMotion,
  writeMotionArtifacts,
} from './motion.ts';
import { captureHoverStates, writeHoverArtifacts } from './hover.ts';
import { captureScrollLinkedMotion, writeScrollMotionArtifacts } from './scroll-motion.ts';
import { extractTokens, writeTokenArtifacts, extractCSSVars } from './tokens.ts';
import { detectSections, captureSectionScreenshots } from './sections.ts';
import { writeRebuildMd, writeStackMd } from './rebuild.ts';
import {
  extractSectionContent,
  linkAssetsToSections,
  writeContentArtifacts,
  harvestBackgroundImages,
} from './content.ts';
import { extractSectionLayouts, writeLayoutArtifacts } from './layout.ts';
import { generateFontFaceCSS } from './fonts.ts';
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

  console.log('▶ phase 1: navigate');
  await page.goto(opts.url, { waitUntil: 'networkidle', timeout: 60000 }).catch(async () => {
    console.warn('  ⚠️  networkidle timeout, falling back to load');
    await page.goto(opts.url, { waitUntil: 'load', timeout: 60000 });
  });
  await page.waitForTimeout(2000);

  // CDP capture has to happen on the FIRST scroll-through, otherwise
  // framer-motion's `whileInView`/`once` triggers won't refire on a 2nd pass.
  console.log('\n▶ phase 1b: CDP animation capture (during scroll)');
  const cdp = await context.newCDPSession(page);
  const cdpRaw = await captureCDPAnimations(cdp, page, 12000);
  console.log(`  🎞  ${cdpRaw.length} CDP animations fired during scroll`);

  // Sampled scroll: captures viewport screenshots + lazy-image deltas + visible
  // framer-named regions at every scroll step.
  console.log('\n▶ phase 1c: sampled scroll capture');
  const scrollSamples = await sampledScrollCapture(page, opts.outDir);

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

  console.log('\n▶ phase 4: design tokens + source CSS vars');
  const tokens = await extractTokens(page);
  const cssVars = await extractCSSVars(page).catch(() => []);
  await writeTokenArtifacts(opts.outDir, tokens, cssVars);

  console.log('\n▶ phase 5: section detection + per-section captures');
  const sections = await detectSections(page);
  await captureSectionScreenshots(page, opts.outDir, sections, opts.viewports);

  console.log('\n▶ phase 6: classify + link motion to sections');
  console.log(`  🎞  resolving ${new Set(cdpRaw.map((a) => a.backendNodeId).filter(Boolean)).size} CDP node ids → bbox`);
  const cdpResolved = await resolveCDPAnimationNodes(cdp, cdpRaw);
  let computed = await scanComputedTransitions(page);

  // classify + tag stagger groups + char stagger (CSS path)
  for (const a of computed) a.classification = classifyAnimatedElement(a);
  computed = tagStaggerGroups(computed);
  computed = detectCharStagger(computed);
  for (const a of cdpResolved) a.classification = classifyCDPAnimation(a);

  // link both to sections by bbox containment
  const computedLinked = linkAnimationsToSections(computed, sections);
  let cdpLinked = linkAnimationsToSections(cdpResolved, sections);

  // CDP-based stagger detection (catches framer-motion WAAPI char-stagger that
  // CSS scan can't see). Has to run AFTER section linking.
  cdpLinked = tagCDPStaggerGroups(cdpLinked);

  await writeMotionArtifacts(opts.outDir, computedLinked, cdpLinked, stack);

  console.log('\n▶ phase 7: deep content extraction (text, images, bg, framer attrs)');
  const sectionContents = await extractSectionContent(page, sections);
  await harvestBackgroundImages(page, opts.outDir, assets.manifest);
  const augmentedManifest = linkAssetsToSections(assets.manifest, sectionContents);

  console.log('\n▶ phase 8: structural layout trees per section');
  const layouts = await extractSectionLayouts(page, sections);
  await writeLayoutArtifacts(opts.outDir, layouts);

  console.log('\n▶ phase 9: hover-state capture (cursor:pointer + buttons/links)');
  const hovers = await captureHoverStates(page, sections, 5).catch((e) => {
    console.warn('  ⚠️  hover capture failed:', (e as Error).message);
    return [];
  });
  await writeHoverArtifacts(opts.outDir, hovers);

  console.log('\n▶ phase 9b: scroll-linked motion (pin-scrub, parallax, scroll-scaled)');
  const { behaviors: scrollBehaviors, sectionBgColors } = await captureScrollLinkedMotion(page, sections).catch((e) => {
    console.warn('  ⚠️  scroll-motion capture failed:', (e as Error).message);
    return { behaviors: [], sectionBgColors: new Map<string, string>() };
  });
  await writeScrollMotionArtifacts(opts.outDir, scrollBehaviors, sectionBgColors);

  console.log('\n▶ phase 10: per-section motion summary + finalize artifacts');
  const sectionMotion = summarizeSectionMotion(sections, computedLinked, cdpLinked, hovers);
  await writeFile(
    join(opts.outDir, 'motion', 'per-section.json'),
    JSON.stringify(sectionMotion, null, 2),
    'utf8'
  );
  await assets.finalize();
  await writeContentArtifacts(opts.outDir, sectionContents, augmentedManifest);
  await generateFontFaceCSS(opts.outDir);
  await writeStackMd(opts.outDir, stack);

  const meta: Meta = {
    url: opts.url,
    capturedAt: new Date().toISOString(),
    name: opts.name,
    viewports: opts.viewports,
    pageTitle,
    stack,
    sectionCount: sections.length,
    animationCount: computedLinked.length + cdpLinked.length,
    assetCount: assets.manifest.length,
  };
  await writeFile(join(opts.outDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  await writeRebuildMd(opts.outDir, meta, sections, sectionContents, sectionMotion, hovers, scrollBehaviors, sectionBgColors);

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
