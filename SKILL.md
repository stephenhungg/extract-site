---
name: extract-site
version: 0.4.0
description: |
  Reverse-engineer any website (especially Framer sites) into a structured reference/ folder
  containing static DOM, screenshots, motion specs (durations + easing curves + framer-motion
  props), assets, design tokens, and an auto-generated REBUILD.md prompt — then rebuild it as
  clean, editable code (Next.js + Tailwind + GSAP, or Vite + React + framer-motion). Verify
  fidelity by diffing the rebuild against the LIVE original URL with the shipped probe.mjs.
  Never mirror Framer's runtime (copy its html/js + string-swap) — that's a dead end; always
  rebuild clean. Uses a HEADED Chromium (required — headless captures zero motion). Read
  PLAYBOOK.md for the full method. Use when asked to "extract this site", "reverse engineer this
  framer", "clone this site", "rip motion specs", "get the easing curves", or "give me the
  design tokens".
triggers:
  - extract this site
  - reverse engineer this site
  - clone this framer site
  - rebuild this framer
  - rip the motion from
  - get easing curves from
  - extract design tokens from
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - AskUserQuestion
---

# extract-site

End-to-end site extraction pipeline. Point it at a URL, get a `reference/` folder Claude Code can use as ground truth to rebuild the site.

> **Agent playbook:** for the full Framer reverse-engineering methodology — path
> selection (mirror vs rebuild), the dual-oracle verification principle, the
> capture mechanics, the Next.js + Tailwind + GSAP port workflow, and the
> real-build lessons (angel/kali/yuya) — read [`PLAYBOOK.md`](./PLAYBOOK.md).

## When to invoke

The user is asking to recreate, clone, or rip apart a deployed website. Most often a Framer site whose motion/taste they want to capture. Also works on any modern site (Webflow, Next, Vercel-hosted, etc.).

**Triggers:** "extract this site", "reverse engineer", "clone this", "rip motion from", "what's the easing on", "get the design tokens from".

## When NOT to invoke (decision gate — read first)

The skill captures *data about* a site (motion specs, tokens, assets, screenshots). It does **not** produce a runnable copy of the site. Before invoking, ask:

1. **Does the user expect a byte-perfect, indistinguishable copy?** Set expectations: a clean rebuild lands at ~85-95% fidelity, never 100% — fonts render differently, spring physics are inferred (not measured), pseudo-elements aren't captured, per-breakpoint layout variants are screenshot-only. That's the ceiling; the verification loop (probe.mjs vs the live URL) is how you get as close to it as possible. Do NOT try to mirror Framer's runtime to chase 100% — that's a dead end (minified hashes change every build, unmaintainable). Always rebuild clean.

2. **Does the user already have a working mirror and just want to edit it?** If yes → **don't extract, fix the modification pipeline**. Extracting again won't help them change "the email address" or "the hero copy" — that's a config/templating problem, not an extraction problem.

3. **Does the user want a clean rebuild for maintainability/extensibility, accepting some visual drift?** If yes → invoke this skill. The extracted reference becomes ground truth for a new React/Astro/Next/etc. build.

**Realistic fidelity ceiling:** 85-95% for Framer sites that use Motion (the best case). 75-85% for other stacks. Spring stiffness/damping are inferred from curve shape (not measured). Layout tree is captured at desktop only — mobile/tablet are screenshot-only. Pseudo-elements (`::before`/`::after`) are invisible. State this ceiling to the user **before** committing to a rebuild path.

## Setup (run once, idempotent)

```bash
cd ~/.claude/skills/extract-site
[ -d node_modules ] || bun install
[ -d ~/.cache/ms-playwright/chromium-* ] || bunx playwright install chromium
```

**Heads up:** the chromium install on a fresh machine takes 30-90s and downloads ~150MB. Tell the user this before running so they don't think the skill hung. After install, `~/.cache/ms-playwright/chromium-*` will exist and subsequent runs are fast.

## Usage

Two commands. Extract a site, then rebuild it clean.

```bash
# extract — rip a deployed site into a reference/ folder (HEADED; never --headless)
extract-site <url> [--out <dir>] [--name <slug>] [--routes] [--max-routes <n>]

# rebuild — scaffold an editable Vite+React+framer-motion project from a reference
extract-site rebuild <reference-dir> [--out <project-dir>] [--name <slug>]

extract-site help
```

Defaults:
- `extract <url>` writes to `./reference/<slug>/` (slug derived from hostname)
- `--routes` crawls same-origin routes → `./reference/<slug>/<route>/` per page
- `rebuild <reference>` writes to `./<slug>-rebuild/` (use `--out` to override)
- Extraction is HEADED (required — headless captures zero motion)

Verify the rebuild against the live URL with `probe.mjs` / `motion-probe.mjs` (see
PLAYBOOK.md §4). For the converged Next.js + Tailwind + GSAP hand-port, follow
PLAYBOOK.md §5 — there's no command for it; it's a manual port.

## What it produces

```
reference/<name>/
├── meta.json                  # url, captured-at, detected stack, viewport list
├── REBUILD.md                 # final prompt template, ready to paste into Claude Code
├── dom/
│   ├── full.html              # complete inlined dom (single-file style)
│   └── sections/01-hero.html  # per-section subtrees
├── screenshots/
│   ├── desktop-full.png mobile-full.png tablet-full.png
│   └── sections/01-hero-{desktop,tablet,mobile}.png
├── motion/
│   ├── animations.json        # every animated element: selector, duration, easing, delay
│   ├── motion-specs.md        # human-readable cheat sheet (degrades to defaults if CDP fires 0)
│   ├── scroll-motion.json     # scroll-linked behaviors (pinned/parallax/scrub)
│   ├── appear-effects.json    # entrance from-states (opacity:0, translateY…)
│   └── hover-fiber.json hover-thorough.json   # hover specs
├── assets/
│   ├── images/ videos/ fonts/  # hash-prefixed filenames, real detected extension
│   └── manifest.json          # original urls -> on-disk local paths
├── content/
│   └── layouts.json sections.json text.md
├── tokens/
│   ├── colors.json typography.json spacing.json
│   ├── tokens.css             # ready-to-import css vars
│   ├── fonts.css              # @font-face for captured fonts
│   └── source-vars.css        # the site's OWN named --vars (best Tailwind seed)
└── stack/
    └── detected.md            # framer-motion? lenis? gsap? next? three?
```

> See `PLAYBOOK.md` for the exact, complete output tree. `motion-specs.md` is only
> "the gold" when CDP captures discrete animations — on `motion/react` sites it
> degrades to generic defaults, and the real signal is in `appear-effects.json` +
> `scroll-motion.json` + REBUILD.md's per-section motion tables.

## Workflow: extract → rebuild → verify

**There is one path: rebuild clean.** Do NOT mirror Framer's runtime (copy its
html/js and string-swap content) — it's a maintenance dead end (minified hashes
change every build). Full method is in `PLAYBOOK.md`; the short version:

### 1. extract

```bash
extract-site <url>                            # single page → ./reference/<slug>/
extract-site <url> --routes [--max-routes 20] # multi-page → ./reference/<slug>/<route>/
```

Headed browser (never `--headless`) scrolls the page, captures animations, harvests
assets, dumps DOM + screenshots + tokens. ~60-90s per page. Headless is forbidden:
`motion/react` + GSAP need a real render context, so headless captures zero motion.
For multi-page sites, `--routes` discovers same-origin routes from the homepage and
extracts each into its own subfolder (rebuild each as a Next.js route).

### 2. rebuild (two routes)

**Fast auto-transpile** (Vite + React + framer-motion, ~95% out of the box):

```bash
extract-site rebuild ./reference/<slug> --out ./<project>
cd <project> && bun install && bun run dev          # → http://localhost:5173
```

Generates a vite + react + framer-motion project that:
- preserves framer's CSS verbatim → layouts render correctly
- inlines per-element computed styles (from extract-site's computed-styles.json) → individual element sizing/positioning is correct
- splits the page into editable section files under `src/sections/<NN>-<Name>.ts` (each is an HTML template literal you edit; vite hot-reloads)
- assembles them in `src/page.tsx` (the page shell)
- runs entry animations via framer-motion in `src/animations.ts`

Visual fidelity: **~95% of the original** out the box. Edit `src/sections/*.ts` for content/layout changes, `src/app.css` for global overrides, `src/animations.ts` for entry motion, `src/page.tsx` for shell-level structure.

Caveats:
- per-element animations beyond entry fade are best-effort
- font subsets that didn't load during scroll aren't downloaded — re-extract with more scrolling, or hand-add the `@font-face`/Google Fonts import
- produces working code, not pixel-perfect 1:1 — close the gap with the verify loop (step 3)

**Converged hand-port** (Next.js + Tailwind + GSAP): no command generates this —
hand-port section by section using the `reference/` artifacts as ground truth.
Full workflow, decision rules, and gotchas are in `PLAYBOOK.md §5`.

### 3. verify against the LIVE original URL

The oracle is the live site, not a copy. With your rebuild running on localhost:

```bash
bun probe.mjs <originalUrl> http://localhost:5173 ./reference/<slug>   # CSS parity → css-diff.md
bun motion-probe.mjs <originalUrl>                                     # motion keyframes (compare both)
```

Iterate `css-diff.md` to single-digit diffs; diff your section screenshots against
`reference/<slug>/screenshots/sections/*`. Both probes are headed (`headless:false`).

## How the agent should run this

When the user invokes the skill or asks to extract a site:

1. **Confirm the URL** if not provided, with one short AskUserQuestion call.
2. **Run setup if needed** (the bash block above is idempotent).
3. **Run the CLI** with appropriate flags. Pipe output so the user sees progress.
4. **Read `meta.json` and `motion-specs.md`** after extraction completes.
5. **Summarize what was captured** in 3-5 lines:
   - Detected stack (framer-motion? lenis? gsap?)
   - Number of sections, screenshots, animations captured
   - Number of assets harvested
   - Path to `REBUILD.md`
6. **Offer next step**: "want me to start rebuilding section-by-section using this reference?"

## Key behaviors

- **Always headed. Never `--headless`.** `motion/react` + GSAP are rAF + IntersectionObserver driven and hover needs a real render context — headless silently captures a site with zero motion. The `--headless` flag exists only for CI on static (non-Framer) sites.
- **Don't extract authenticated/paywalled sites** without explicit user confirmation that they have rights.
- **Don't run on huge sites** (e.g., full e-commerce catalogs). Best for landing pages, marketing sites, single product pages. Warn if the page has > 50 sections.
- **The CLI is also a standalone tool.** The user can run it directly without invoking the skill. The skill exists to teach Claude *when* and *how* to use it, and to interpret the output.

## The rebuild prompt template (what gets written to REBUILD.md)

```
You have a complete reference capture in <path>/reference/<name>/.

Stack detected: {detected stack}
Target: rebuild this site in {user's chosen framework, default Next.js + Tailwind + framer-motion + Lenis}.

Rules:
1. Build section-by-section. Hero first. Don't move on until the section matches the reference screenshot at all 3 viewports.
2. For motion: use the EXACT durations and easing arrays from motion/motion-specs.md. Do not invent values.
3. For colors/typography/spacing: import tokens/tokens.css (or seed from tokens/source-vars.css). Don't pick new values.
4. For assets: use the exact on-disk paths in the section blocks (hash-prefixed, real extension) or resolve via assets/manifest.json — the bare original filenames don't exist on disk. Don't regenerate.
5. After each section: screenshot the build, diff against reference/screenshots/sections/NN-*.png, AND run probe.mjs against the live URL. Fix mismatches before moving on.

Sections (build in order):
{auto-generated section table with image refs and motion notes}
```

## Common follow-ups the agent should anticipate

- *"Just give me the easing curves"* → `cat reference/<name>/motion/motion-specs.md`
- *"Just the colors"* → `cat reference/<name>/tokens/colors.json`
- *"Rebuild it"* → start a new task, work through sections one at a time, use the screenshot diff loop.

## Limits (v0.1)

- No authenticated sites (no cookie injection yet)
- Canvas/WebGL scenes captured as screenshots only (no scene graph extraction)
- A/B test variants: whichever loads is what you get
- Sites that gate by user-agent or geofence may not capture cleanly
