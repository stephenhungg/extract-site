import { writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { Meta, SectionInfo, DetectedStack, HoverState, AssetManifestEntry } from './types.ts';
import type { SectionContent } from './content.ts';
import type { SectionMotionSummary } from './motion.ts';
import type { ScrollBehavior } from './scroll-motion.ts';
import type { TransitionSpec } from './transitions.ts';

export async function writeRebuildMd(
  outDir: string,
  meta: Meta,
  sections: SectionInfo[],
  contents: SectionContent[] = [],
  motion: SectionMotionSummary[] = [],
  hovers: HoverState[] = [],
  scrollBehaviors: ScrollBehavior[] = [],
  sectionBgColors: Map<string, string> = new Map(),
  transitions: TransitionSpec[] = [],
  manifest: AssetManifestEntry[] = []
) {
  const stack = meta.stack;
  const recommended = recommendedStack(stack);

  // Resolve an original asset URL to its actual on-disk path. extract-site saves
  // assets with an 8-char hash prefix and the magic-byte-detected extension
  // (e.g. a `.png` URL whose bytes are avif becomes `<hash>-name.avif`), so the
  // bare original filename does NOT exist on disk. Without this, every image
  // path in REBUILD.md would 404 a rebuild. localPath is relative to outDir.
  const byUrl = new Map(manifest.map((m) => [m.originalUrl, m]));
  const resolveAsset = (src: string): string | null => {
    const entry = byUrl.get(src) ?? byUrl.get(src.split('?')[0]);
    if (!entry) return null;
    // normalize to a reference-relative path like `assets/images/<hash>-name.avif`
    return entry.localPath.replace(/^.*?(assets\/)/, '$1');
  };

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
  lines.push(`├── assets/{images,videos,fonts}/  # everything harvested (hash-prefixed names)`);
  lines.push(`├── assets/manifest.json       # original urls -> on-disk local paths`);
  lines.push(`├── tokens/{colors,typography,spacing}.json`);
  lines.push(`├── tokens/tokens.css          # ready-to-import css vars`);
  lines.push(`├── tokens/fonts.css           # @font-face for captured fonts`);
  lines.push(`└── stack/detected.md          # framework detection notes`);
  lines.push(`\`\`\`\n`);

  lines.push(`## Rules of engagement (95%+ fidelity required)\n`);
  lines.push(`This is a **1:1 reproduction**, not a "spiritually similar" rebuild. Concrete rules:\n`);
  lines.push(`1. **Use the actual text.** Every headline, paragraph, button label, link is in \`content/text.md\` and \`content/sections.json\`. Do not paraphrase, do not "improve" copy, do not make up filler.`);
  lines.push(`2. **Use the actual images.** Each section block below lists the **exact on-disk path** for every image (hash-prefixed, with the real detected extension — e.g. \`assets/images/930cdbce-name.avif\`). Copy those files into your project's \`public/\` and reference them. The bare original filenames do NOT exist on disk; use the paths as written, or \`assets/manifest.json\` (\`originalUrl\` → \`localPath\`) to resolve. If a section has a hero image, your section MUST have that exact image — not a CSS gradient stand-in.`);
  lines.push(`3. **Use the actual fonts.** \`tokens/fonts.css\` has \`@font-face\` declarations for every captured woff2/ttf. Import it. Don't substitute Google Fonts unless the source font wasn't captured.`);
  lines.push(`4. **For motion: EXACT values from \`motion/motion-specs.md\`.** No "ease-out", no "0.5s". Use the bezier arrays and durations as captured.`);
  lines.push(`5. **For tokens: import \`tokens/tokens.css\`.** Don't pick new colors, font sizes, or spacing values.`);
  lines.push(`6. **Build section-by-section.** Don't move on until your section matches the reference at all 3 viewports. Screenshot diff after each.`);
  lines.push(`7. **Use the layout tree.** \`content/layouts.json\` has the structural skeleton — flex/grid directions, gaps, child order. Match it.`);
  lines.push(`8. **Smooth scroll**: ${stack.lenis ? 'the source uses Lenis — install `lenis` and wire it up at the root.' : 'consider adding Lenis for that "Framer feel" if the source has any scroll-linked motion.'}`);
  lines.push(`9. **No placeholder content.** No "Lorem ipsum", no "Project Name", no fake stats. The real numbers, names, and copy are extracted.`);

  lines.push(`\n## Sections — exact content (build verbatim)\n`);
  lines.push(`> Every section below has its **exact text, images, fonts, and computed styles** captured. Do not rewrite copy. Do not pick new assets. Do not invent font sizes. Use what's here.\n`);

  const contentBySlug = new Map(contents.map((c) => [c.slug, c]));
  const motionBySlug = new Map(motion.map((m) => [m.slug, m]));
  const hoversBySlug = new Map<string, HoverState[]>();
  for (const h of hovers) {
    if (!h.sectionSlug) continue;
    if (!hoversBySlug.has(h.sectionSlug)) hoversBySlug.set(h.sectionSlug, []);
    hoversBySlug.get(h.sectionSlug)!.push(h);
  }

  // Group scroll behaviors by section
  const scrollBySlug = new Map<string, ScrollBehavior[]>();
  for (const b of scrollBehaviors) {
    if (!b.sectionSlug) continue;
    if (!scrollBySlug.has(b.sectionSlug)) scrollBySlug.set(b.sectionSlug, []);
    scrollBySlug.get(b.sectionSlug)!.push(b);
  }

  for (const s of sections) {
    const c = contentBySlug.get(s.slug);
    const m = motionBySlug.get(s.slug);
    const sectionHovers = hoversBySlug.get(s.slug) || [];
    const sectionScroll = scrollBySlug.get(s.slug) || [];
    const bgColor = sectionBgColors.get(s.slug);
    lines.push(`\n### ${s.index}. \`${s.slug}\``);
    if (c?.framer.name) lines.push(`*framer name: ${c.framer.name}*`);
    if (bgColor && bgColor !== 'rgba(0, 0, 0, 0)' && bgColor !== 'transparent') {
      lines.push(`**Background:** \`${bgColor}\``);
    }
    lines.push('');
    lines.push(`- screenshot (desktop): \`screenshots/sections/${s.slug}-desktop.png\``);
    lines.push(`- screenshot (tablet): \`screenshots/sections/${s.slug}-tablet.png\``);
    lines.push(`- screenshot (mobile): \`screenshots/sections/${s.slug}-mobile.png\``);
    lines.push(`- dom subtree: \`dom/sections/${s.slug}.html\``);
    lines.push(`- structural layout tree: \`content/layouts.json\` → find \`"slug": "${s.slug}"\``);

    // Motion block — the v0.4 payoff. Concrete instructions per section.
    if (m && (m.notable.length || m.cdpFired || m.totalAnimated)) {
      lines.push('');
      lines.push(`**Motion (${m.totalAnimated} animated · ${m.cdpFired} fired during scroll):**`);
      if (m.dominantEasing && m.dominantDurationMs) {
        lines.push(`- defaults: ${m.dominantDurationMs}ms × \`${m.dominantEasing}\``);
      }
      for (const n of m.notable) lines.push(`- ${n}`);
    }

    // Scroll-linked motion block — the v0.6 payoff. The motion that doesn't
    // fire as a discrete animation but is JS-scrubbed to scroll position.
    // This is what GSAP ScrollTrigger.scrub does, what framer's useScroll
    // does. The classic example: a hero that shrinks + pins as you scroll.
    if (sectionScroll.length) {
      lines.push('');
      lines.push(`**Scroll-linked motion (${sectionScroll.length} elements):**`);
      for (const b of sectionScroll.slice(0, 8)) {
        const tag = b.framerName ? `\`${b.framerName}\`` : `\`${b.tag}\``;
        const kinds = b.kind.join(', ');
        const parts: string[] = [];
        if (b.scaleStart && b.scaleEnd && b.scaleStart !== b.scaleEnd) {
          parts.push(`scale ${b.scaleStart}→${b.scaleEnd}`);
        }
        if (b.translateYStart !== undefined && b.translateYEnd !== undefined) {
          parts.push(`translateY ${b.translateYStart}→${b.translateYEnd}px`);
        }
        if (b.translateXStart !== undefined && b.translateXEnd !== undefined) {
          parts.push(`translateX ${b.translateXStart}→${b.translateXEnd}px`);
        }
        if (b.rotateStart !== undefined && b.rotateEnd !== undefined) {
          parts.push(`rotate ${b.rotateStart}°→${b.rotateEnd}°`);
        }
        if (b.opacityStart !== undefined && b.opacityEnd !== undefined) {
          parts.push(`opacity ${b.opacityStart}→${b.opacityEnd}`);
        }
        const transformStr = parts.length ? ` — ${parts.join(', ')}` : '';
        const scrollStr = `over scrollY ${b.scrollFrom}→${b.scrollTo}px`;
        lines.push(`- ${tag} \`${kinds}\`${transformStr} ${scrollStr}`);
      }
      if (sectionScroll.length > 8) {
        lines.push(`- ...and ${sectionScroll.length - 8} more (see \`motion/scroll-motion.json\`)`);
      }
      // Generic implementation hint
      const hasPinScrub = sectionScroll.some((b) => b.kind.includes('pin-scrub'));
      const hasParallax = sectionScroll.some((b) => b.kind.includes('parallax'));
      if (hasPinScrub) {
        lines.push(`- 🔑 **pin-scrub pattern detected** — implement with framer-motion \`useScroll\` + \`useTransform\`, or GSAP \`ScrollTrigger.create({pin:true, scrub:true})\``);
      }
      if (hasParallax) {
        lines.push(`- parallax: bind translateY to scrollYProgress with negative multiplier (e.g. \`useTransform(p, [0,1], ['0%','-30%'])\`)`);
      }
    }
    if (sectionHovers.length) {
      lines.push('');
      lines.push(`**Hover states (${sectionHovers.length}):**`);
      for (const h of sectionHovers) {
        const props = Object.keys(h.delta).slice(0, 4).join(', ');
        const text = h.text ? `"${h.text}"` : (h.framerName ? `\`${h.framerName}\`` : `\`${h.selector.split(' > ').pop()}\``);
        lines.push(`- ${text} — changes: ${props} — ${h.duration} \`${h.easing}\``);
      }
    }
    if (!c) continue;

    if (c.text.labels.length) {
      lines.push(`- **labels (small/uppercase):** ${c.text.labels.map((l) => `\`${l}\``).join(' · ')}`);
    }
    if (c.text.headings.length) {
      lines.push(`\n**Headings:**`);
      for (const h of c.text.headings) {
        lines.push(
          `- h${h.level}: "${h.text}" — ${h.style.fontSize} / ${h.style.fontWeight} / ${h.style.color} / family: \`${h.style.fontFamily.split(',')[0]}\`${h.style.fontStyle === 'italic' ? ' / italic' : ''}`
        );
      }
    }
    if (c.text.paragraphs.length) {
      lines.push(`\n**Paragraphs:**`);
      for (const p of c.text.paragraphs.slice(0, 8)) {
        lines.push(`- "${p.text}" — ${p.style.fontSize} / ${p.style.color}`);
      }
    }
    if (c.text.buttons.length) {
      lines.push(`\n**Buttons:** ${c.text.buttons.map((b) => `\`${b.text}\``).join(' · ')}`);
    }
    if (c.text.links.length) {
      const uniqLinks = Array.from(new Set(c.text.links.map((l) => l.text))).slice(0, 12);
      lines.push(`\n**Links:** ${uniqLinks.map((l) => `\`${l}\``).join(' · ')}`);
    }
    if (c.images.length) {
      lines.push(`\n**Images (${c.images.length}):**`);
      for (const img of c.images.slice(0, 8)) {
        const path = resolveAsset(img.src);
        const ref = path ? `\`${path}\`` : `(not harvested — fetch from source: ${img.src})`;
        lines.push(
          `- ${img.role}, ${img.bbox.width}×${img.bbox.height}${img.alt ? ` — alt: "${img.alt}"` : ''} → ${ref}`
        );
      }
    }
    if (c.videos.length) {
      lines.push(`\n**Videos:**`);
      for (const v of c.videos) {
        const path = resolveAsset(v.src);
        const ref = path ? `\`${path}\`` : `(not harvested — fetch from source: ${v.src})`;
        lines.push(`- ${v.bbox.width}×${v.bbox.height} → ${ref}`);
      }
    }
    if (c.backgrounds.length) {
      lines.push(`\n**CSS background-image urls:**`);
      for (const b of c.backgrounds.slice(0, 5)) {
        const path = resolveAsset(b.url);
        const ref = path ? `\`${path}\`` : `(not harvested — fetch from source: ${b.url})`;
        lines.push(`- on \`${b.selector}\`: ${ref}`);
      }
    }
    if (c.svgs.length) {
      lines.push(`\n**Inline SVGs:** ${c.svgs.length} (full markup in \`content/sections.json\`)`);
    }
  }

  // Section-boundary transitions — the choreography BETWEEN sections
  if (transitions.length) {
    lines.push(`\n## Section Transitions (the choreography between sections)\n`);
    lines.push(`> Real "Framer feel" lives at section boundaries: bg cross-fades, pin handoffs, exit/enter sequences. These are JS-driven (framer-motion \`useScroll\` / GSAP \`ScrollTrigger.scrub\`), not discrete CSS animations — easy to miss if you only look at per-section motion.\n`);
    for (const t of transitions) {
      lines.push(`### ${t.fromSlug} → ${t.toSlug}`);
      lines.push(`*${t.summary}*`);
      lines.push(`- scroll window: ${t.scrollFrom}→${t.scrollTo}px`);
      if (t.bgCrossfade) {
        lines.push(`- 🎨 **bg crossfade**: \`${t.bgCrossfade.fromColor}\` → \`${t.bgCrossfade.toColor}\` over ${t.bgCrossfade.crossfadeOver}px`);
      }
      if (t.bridging.length) {
        lines.push(`- 🌉 **bridging** (pinned/scrub spanning the boundary):`);
        for (const e of t.bridging) {
          const tag = e.framerName ? `\`${e.framerName}\`` : `\`${e.tag}\``;
          const parts: string[] = [];
          if (e.scaleStart && e.scaleEnd) parts.push(`scale ${e.scaleStart}→${e.scaleEnd}`);
          if (e.translateYStart !== undefined && e.translateYEnd !== undefined) parts.push(`tY ${e.translateYStart}→${e.translateYEnd}px`);
          if (e.opacityStart !== undefined && e.opacityEnd !== undefined) parts.push(`op ${e.opacityStart}→${e.opacityEnd}`);
          lines.push(`  - ${tag} [${e.kind.join(',')}]${parts.length ? ' — ' + parts.join(', ') : ''}${e.text ? ` — "${e.text.slice(0, 40)}"` : ''}`);
        }
      }
      if (t.exiting.length) {
        lines.push(`- ⬆ **exiting** (section A elements leaving):`);
        for (const e of t.exiting) {
          const tag = e.framerName ? `\`${e.framerName}\`` : `\`${e.tag}\``;
          lines.push(`  - ${tag} [${e.kind.join(',')}]${e.text ? ` — "${e.text.slice(0, 40)}"` : ''}`);
        }
      }
      if (t.entering.length) {
        lines.push(`- ⬇ **entering** (section B elements arriving):`);
        for (const e of t.entering) {
          const tag = e.framerName ? `\`${e.framerName}\`` : `\`${e.tag}\``;
          lines.push(`  - ${tag} [${e.kind.join(',')}]${e.text ? ` — "${e.text.slice(0, 40)}"` : ''}`);
        }
      }
      lines.push('');
    }
    lines.push(`> 🔑 **How to implement**: wrap consecutive sections in a single \`useScroll({target: containerRef})\` and drive bg color via \`useTransform(scrollYProgress, [0.4, 0.6], [fromBg, toBg])\`. For bridging elements, use \`position: sticky\` + scale/opacity mapped to the same scroll progress. Full data in \`motion/transitions.json\`.\n`);
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
