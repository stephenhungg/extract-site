import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SectionInfo } from './types.ts';
import type { ScrollBehavior } from './scroll-motion.ts';

// SECTION-BOUNDARY TRANSITIONS
//
// scroll-motion.ts captures per-element behavior across scroll positions.
// But the rebuild needs more than "this element scaled here" — it needs
// "between section A and section B, here's the choreography that fires."
//
// At the boundary between two adjacent sections (e.g. achievements -> what-we-do),
// real sites typically do one or more of:
//   - background cross-fade (dark → light)
//   - section A pins while section B rises behind/over it (handoff)
//   - section A's heading translates up + fades while section B's enters
//   - hero element shrinks into a corner as next section reveals
//   - decorative element passes between (a marquee, a divider line)
//
// This module groups scroll-motion behaviors by which boundary they straddle,
// and emits per-boundary transition specs that the rebuild prompt can act on.

export interface TransitionSpec {
  fromSlug: string;
  fromName?: string;
  fromBg: string;
  toSlug: string;
  toName?: string;
  toBg: string;
  // The scroll-Y range over which the transition is observable
  scrollFrom: number;
  scrollTo: number;
  // Background cross-fade if from/to bg colors differ
  bgCrossfade?: { fromColor: string; toColor: string; crossfadeOver: number };
  // Elements that exit (active in section A, leaving as B enters)
  exiting: TransitionElement[];
  // Elements that enter (just becoming visible / animating in as B starts)
  entering: TransitionElement[];
  // Elements that bridge — pinned + transformed across the boundary (the
  // hero-shrinks-into-frame pattern is this).
  bridging: TransitionElement[];
  // One-line human summary
  summary: string;
}

export interface TransitionElement {
  framerName?: string;
  tag: string;
  text?: string;
  kind: string[];
  scaleStart?: number;
  scaleEnd?: number;
  translateYStart?: number;
  translateYEnd?: number;
  opacityStart?: number;
  opacityEnd?: number;
}

export function synthesizeTransitions(
  sections: SectionInfo[],
  behaviors: ScrollBehavior[],
  sectionBgColors: Map<string, string>
): TransitionSpec[] {
  const out: TransitionSpec[] = [];
  const sortedSections = sections.slice().sort((a, b) => a.bbox.y - b.bbox.y);

  for (let i = 0; i < sortedSections.length - 1; i++) {
    const a = sortedSections[i];
    const b = sortedSections[i + 1];

    // Boundary scrollY = the point where section A's bottom meets B's top.
    // Transition window = ±0.5 viewports around the boundary (heuristic).
    const boundary = b.bbox.y; // scrollY at which section B's top hits viewport top
    const window = 700; // ~1 viewport of slop on either side
    const scrollFrom = Math.max(0, boundary - window);
    const scrollTo = boundary + window;

    // Find behaviors that straddle this boundary
    const straddling = behaviors.filter((bh) => {
      // Behavior's scroll range overlaps the boundary window
      if (bh.scrollFrom > scrollTo) return false;
      if (bh.scrollTo < scrollFrom) return false;
      // Element must actually have changed something across this window
      return true;
    });

    const exiting: TransitionElement[] = [];
    const entering: TransitionElement[] = [];
    const bridging: TransitionElement[] = [];

    for (const bh of straddling) {
      const el: TransitionElement = {
        framerName: bh.framerName,
        tag: bh.tag,
        text: bh.text,
        kind: bh.kind,
        scaleStart: bh.scaleStart,
        scaleEnd: bh.scaleEnd,
        translateYStart: bh.translateYStart,
        translateYEnd: bh.translateYEnd,
        opacityStart: bh.opacityStart,
        opacityEnd: bh.opacityEnd,
      };
      // Bridging: pin-scrub or pinned spanning the boundary
      if (bh.kind.includes('pin-scrub') || (bh.kind.includes('pinned') && bh.scrollFrom < boundary - 100 && bh.scrollTo > boundary + 100)) {
        bridging.push(el);
      } else if (bh.sectionSlug === a.slug) {
        exiting.push(el);
      } else if (bh.sectionSlug === b.slug) {
        entering.push(el);
      } else {
        // Unsectioned but in the boundary window
        if (bh.kind.includes('parallax') || bh.kind.includes('scroll-translated')) entering.push(el);
      }
    }

    const fromBg = sectionBgColors.get(a.slug) || 'unknown';
    const toBg = sectionBgColors.get(b.slug) || 'unknown';
    const isBgFlip = fromBg !== toBg && !fromBg.includes('rgba(0, 0, 0, 0)') && !toBg.includes('rgba(0, 0, 0, 0)');

    // Compose summary
    const summaryParts: string[] = [];
    if (isBgFlip) summaryParts.push(`bg ${fromBg} → ${toBg}`);
    if (bridging.length) summaryParts.push(`${bridging.length} pinned/scrub bridge`);
    if (exiting.length) summaryParts.push(`${exiting.length} exiting`);
    if (entering.length) summaryParts.push(`${entering.length} entering`);
    const summary = summaryParts.length ? summaryParts.join(', ') : 'no scroll-linked transition';

    if (summary === 'no scroll-linked transition' && !isBgFlip) continue; // skip boring boundaries

    out.push({
      fromSlug: a.slug,
      fromName: (a as any).framer,
      fromBg,
      toSlug: b.slug,
      toName: (b as any).framer,
      toBg,
      scrollFrom,
      scrollTo,
      bgCrossfade: isBgFlip ? { fromColor: fromBg, toColor: toBg, crossfadeOver: window * 2 } : undefined,
      exiting: exiting.slice(0, 6),
      entering: entering.slice(0, 6),
      bridging: bridging.slice(0, 4),
      summary,
    });
  }

  return out;
}

export async function writeTransitionArtifacts(outDir: string, transitions: TransitionSpec[]) {
  await mkdir(join(outDir, 'motion'), { recursive: true });
  await writeFile(
    join(outDir, 'motion', 'transitions.json'),
    JSON.stringify(transitions, null, 2),
    'utf8'
  );
  const bgFlips = transitions.filter((t) => t.bgCrossfade).length;
  const bridges = transitions.reduce((n, t) => n + t.bridging.length, 0);
  console.log(`  ⇄ ${transitions.length} section transitions (${bgFlips} bg-flips, ${bridges} bridge elements)`);
}
