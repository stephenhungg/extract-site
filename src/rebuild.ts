import { writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { Meta, SectionInfo, DetectedStack } from './types.ts';

export async function writeRebuildMd(
  outDir: string,
  meta: Meta,
  sections: SectionInfo[]
) {
  const stack = meta.stack;
  const recommended = recommendedStack(stack);

  const lines: string[] = [];
  lines.push(`# REBUILD.md`);
  lines.push(`\n> Auto-generated rebuild brief for **${meta.url}** (captured ${meta.capturedAt})\n`);

  lines.push(`## What you're rebuilding\n`);
  lines.push(`- **Source**: ${meta.url}`);
  lines.push(`- **Page title**: ${meta.pageTitle}`);
  lines.push(`- **Detected stack**: ${recommended.detectedSummary}`);
  lines.push(`- **Recommended stack**: ${recommended.targetSummary}`);
  lines.push(`- **Sections**: ${sections.length}`);
  lines.push(`- **Animations captured**: ${meta.animationCount}`);
  lines.push(`- **Assets**: ${meta.assetCount}`);

  lines.push(`\n## Reference folder layout\n`);
  lines.push(`\`\`\``);
  lines.push(`reference/${meta.name}/`);
  lines.push(`├── meta.json                  # this capture's metadata`);
  lines.push(`├── REBUILD.md                 # ← you are here`);
  lines.push(`├── dom/full.html              # complete inlined dom`);
  lines.push(`├── dom/sections/*.html        # per-section subtrees`);
  lines.push(`├── screenshots/{desktop,tablet,mobile}-full.png`);
  lines.push(`├── screenshots/sections/      # per-section, per-viewport`);
  lines.push(`├── motion/animations.json     # raw capture`);
  lines.push(`├── motion/motion-specs.md     # ★ READ THIS — durations + easings`);
  lines.push(`├── assets/{images,videos,fonts}/  # everything harvested`);
  lines.push(`├── assets/manifest.json       # original urls -> local paths`);
  lines.push(`├── tokens/{colors,typography,spacing}.json`);
  lines.push(`├── tokens/tokens.css          # ready-to-import css vars`);
  lines.push(`└── stack/detected.md          # framework detection notes`);
  lines.push(`\`\`\`\n`);

  lines.push(`## Rules of engagement\n`);
  lines.push(`1. **Build section-by-section.** Hero first. Don't move on until the section matches \`screenshots/sections/01-*-desktop.png\` AND \`-tablet.png\` AND \`-mobile.png\`.`);
  lines.push(`2. **For motion: use EXACT values from \`motion/motion-specs.md\`.** Do not invent durations or easings. If the file says \`cubic-bezier(0.16, 1, 0.3, 1)\`, use that — not "ease-out".`);
  lines.push(`3. **For tokens: import \`tokens/tokens.css\`.** Don't pick new colors, font sizes, or spacing values.`);
  lines.push(`4. **For assets: copy from \`assets/\`** to your project's \`public/\` (or wherever). Don't regenerate or substitute stock photos.`);
  lines.push(`5. **After each section: screenshot diff.** Build the section, take a screenshot at 1440×900, place it next to the reference, and visually diff. Fix any mismatches before the next section.`);
  lines.push(`6. **Smooth scroll**: ${stack.lenis ? 'the source uses Lenis — install `lenis` and wire it up at the root.' : 'consider adding Lenis for that "Framer feel" if the source has any scroll-linked motion.'}`);

  lines.push(`\n## Sections (build in this order)\n`);
  lines.push(`| # | Slug | Tag | Preview | Desktop | Tablet | Mobile |`);
  lines.push(`|---|------|-----|---------|---------|--------|--------|`);
  for (const s of sections) {
    const preview = (s.textPreview || '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 50);
    lines.push(
      `| ${s.index} | \`${s.slug}\` | \`${s.tag}\` | ${preview} | ${`screenshots/sections/${s.slug}-desktop.png`} | ${`screenshots/sections/${s.slug}-tablet.png`} | ${`screenshots/sections/${s.slug}-mobile.png`} |`
    );
  }

  lines.push(`\n## Per-section build prompt (paste into Claude Code)\n`);
  lines.push('```text');
  lines.push(`Build the "${sections[0]?.slug ?? 'hero'}" section.`);
  lines.push(``);
  lines.push(`Reference (look at all three viewports):`);
  lines.push(`  - reference/${meta.name}/screenshots/sections/${sections[0]?.slug ?? 'hero'}-desktop.png`);
  lines.push(`  - reference/${meta.name}/screenshots/sections/${sections[0]?.slug ?? 'hero'}-tablet.png`);
  lines.push(`  - reference/${meta.name}/screenshots/sections/${sections[0]?.slug ?? 'hero'}-mobile.png`);
  lines.push(``);
  lines.push(`Source DOM subtree (for structure hints, do NOT copy verbatim):`);
  lines.push(`  - reference/${meta.name}/dom/sections/${sections[0]?.slug ?? 'hero'}.html`);
  lines.push(``);
  lines.push(`Tokens to use:`);
  lines.push(`  - reference/${meta.name}/tokens/tokens.css`);
  lines.push(``);
  lines.push(`Motion specs (use EXACT durations/easings):`);
  lines.push(`  - reference/${meta.name}/motion/motion-specs.md`);
  lines.push(``);
  lines.push(`Stack: ${recommended.targetSummary}`);
  lines.push(``);
  lines.push(`Build, then take a screenshot of your output at 1440×900 and diff it against the desktop reference. Iterate until pixel-close. Then handle tablet (768) and mobile (390).`);
  lines.push('```\n');

  lines.push(`## Framer-tier polish checklist\n`);
  lines.push(`- [ ] No "default" easings — every transition uses a specific cubic-bezier from \`motion-specs.md\`.`);
  lines.push(`- [ ] Hero copy enters with word-by-word stagger (\`staggerChildren: 0.1-0.15\`).`);
  lines.push(`- [ ] Section enters use \`whileInView\` with \`viewport={{ once: true, margin: "-10%" }}\`.`);
  lines.push(`- [ ] Smooth scroll is wired (Lenis if the source uses it).`);
  lines.push(`- [ ] All images are local (in \`public/\`), converted to webp.`);
  lines.push(`- [ ] All fonts are self-hosted from \`assets/fonts/\` (don't rely on Framer's CDN).`);
  lines.push(`- [ ] Hover states are 0.2-0.3s ease-out, not snappy/instant.`);
  lines.push(`- [ ] Mobile layout actually works — not just a squished desktop.`);
  lines.push(`- [ ] No console errors. No layout shift on load.`);

  await writeFile(join(outDir, 'REBUILD.md'), lines.join('\n'), 'utf8');
  console.log('  📋 REBUILD.md');
}

function recommendedStack(stack: DetectedStack) {
  const detected: string[] = [];
  if (stack.framework !== 'unknown') detected.push(stack.framework);
  if (stack.framerMotion) detected.push('framer-motion');
  if (stack.framer) detected.push('framer.com (built site)');
  if (stack.webflow) detected.push('webflow');
  if (stack.lenis) detected.push('lenis');
  if (stack.gsap) detected.push('gsap');
  if (stack.three) detected.push('three.js');
  if (stack.splineRuntime) detected.push('spline');

  const target: string[] = ['Next.js (App Router)', 'TypeScript', 'Tailwind CSS', 'Motion (framer-motion)'];
  if (stack.lenis) target.push('Lenis');
  if (stack.gsap) target.push('GSAP + ScrollTrigger');
  if (stack.three || stack.splineRuntime) target.push('react-three-fiber');

  return {
    detectedSummary: detected.length ? detected.join(', ') : 'unknown',
    targetSummary: target.join(' + '),
  };
}

export async function writeStackMd(outDir: string, stack: DetectedStack) {
  const lines: string[] = [];
  lines.push(`# Detected Stack\n`);
  lines.push(`- Framework: \`${stack.framework}\``);
  lines.push(`- Framer Motion: ${stack.framerMotion ? '✅' : '❌'}`);
  lines.push(`- Built with Framer: ${stack.framer ? '✅' : '❌'}`);
  lines.push(`- Webflow: ${stack.webflow ? '✅' : '❌'}`);
  lines.push(`- Lenis smooth scroll: ${stack.lenis ? '✅' : '❌'}`);
  lines.push(`- GSAP: ${stack.gsap ? '✅' : '❌'}`);
  lines.push(`- Three.js: ${stack.three ? '✅' : '❌'}`);
  lines.push(`- Spline runtime: ${stack.splineRuntime ? '✅' : '❌'}`);
  if (stack.notes.length) {
    lines.push(`\n## Notes`);
    for (const n of stack.notes) lines.push(`- ${n}`);
  }
  await writeFile(join(outDir, 'stack', 'detected.md'), lines.join('\n'), 'utf8');
}
