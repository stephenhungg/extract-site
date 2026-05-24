---
name: extract-site
version: 0.4.0
description: |
  Reverse-engineer any website (especially Framer sites) into a structured reference/ folder
  containing static DOM, screenshots, motion specs (durations + easing curves + framer-motion
  props), assets, design tokens, and an auto-generated REBUILD.md prompt. For Framer cloning,
  prefer a raw Framer runtime mirror first: crawl same-origin routes, save html/js/css/json/fonts/
  media, rewrite urls local, and use that mirror as the fidelity oracle before doing any editable
  rebuild or GSAP port. Uses a HEADED Chromium so the user can watch it work. Use when asked to
  "extract this site", "reverse engineer this framer", "clone this site", "mirror this framer",
  "rip motion specs", "get the easing curves", or "give me the design tokens".
triggers:
  - extract this site
  - reverse engineer this site
  - clone this framer site
  - mirror this framer
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

1. **Does the user need indistinguishable visual fidelity?** If yes → skip this skill and **mirror the site instead** (preserve the original DOM/CSS/runtime). A hand-rebuilt React/Tailwind app from extracted data will land at ~85-95% fidelity, never 100% — fonts render differently, spring physics are inferred (not measured), pseudo-elements aren't captured, per-breakpoint layout variants are screenshot-only. If "looks identical to a normal human at a glance" is the bar, this skill is the wrong tool.

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

The CLI is now modular — three lifecycle phases:

```bash
# Phase 1: extract — rip a deployed site into a reference/ folder
extract-site <url> [--out <dir>] [--name <slug>] [--headless]

# Phase 2: init — scaffold an editable customize project from a reference
extract-site init <reference-dir> [--out <project-dir>] [--name <slug>] [--mirror <path>]

# Phase 3: build — apply your config.json to the mirror, output dist/
extract-site build [project-dir] [--strict]
extract-site watch [project-dir]

# meta
extract-site help
```

Defaults:
- `extract <url>` writes to `./reference/<slug>/` (slug derived from hostname)
- `init <reference>` writes to `./<slug>-customized/` (use `--out` to override)
- `build` and `watch` operate on the current dir unless given a project path
- Extraction is headed by default (you watch the browser scroll the page). Pass `--headless` to hide it.

Examples:
```bash
# rip a site
extract-site https://example.framer.website

# turn the reference into an editable project
extract-site init ./reference/example --out ./my-clone

# edit my-clone/config.json, then:
extract-site build ./my-clone           # one-shot build
extract-site watch ./my-clone           # live rebuild on config / css / baseline changes
extract-site build ./my-clone --strict  # fail if any slot drifted
```

## The customize project (what `init` scaffolds)

```
<project>/
  mirror/                   pristine runtime mirror — never edited
  config.json               your overrides (REPLACE side)
  template-baseline.json    auto-populated from the reference (FIND side)
  overrides.css             css patches injected into <head>
  customize.mjs             generic pipeline (cheerio + slot registry + watch + strict)
  package.json              bun-friendly scripts
  README.md                 usage
  .gitignore
```

`customize.mjs` walks every leaf string in `template-baseline.json`, looks up the matching path in `config.json`, and rewrites that string everywhere in `mirror/` → `dist/`. Color tokens under `theme.colors` get hex+rgb expansion. Image filename rewrites go under `images.replacements`.

For project-specific HTML surgery (mailto links, post-hydration injections to survive React #425, hide-by-selector rules), edit the `patchHtml` function in the scaffolded `customize.mjs` — cheerio is pre-loaded against `dist/index.html`.

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
│   ├── motion-specs.md        # human-readable cheat sheet (THE GOLD)
│   └── scroll-recording.webm  # full-page scroll capture
├── assets/
│   ├── images/ videos/ fonts/
│   └── manifest.json          # original urls -> local paths
├── tokens/
│   ├── colors.json typography.json spacing.json
│   └── tokens.css             # ready-to-import css vars
└── stack/
    └── detected.md            # framer-motion? lenis? gsap? next? three?
```

## Raw Framer Mirror First

When the user wants the closest possible Framer clone from a deployed URL, do **not** start with a visual/manual rebuild. First create a raw runtime mirror.

Required behavior:

1. Capture the homepage and crawl same-origin internal routes (`/works`, `/about`, `/project/foo`, etc.), bounded by `--max-routes`.
2. Save browser-loaded html, js modules, css, json, fonts, images, videos, svg, and Framer CDN assets.
3. Use the original navigation response html for each route. Avoid `page.content()` as the primary html source on Framer pages because hydrated React output can produce mismatches.
4. Rewrite captured remote urls to local relative paths.
5. Serve the mirror over local http and verify with scroll-primed screenshots at desktop and mobile.
6. Treat the verified mirror as the oracle for any later editable rebuild.

If a repo already has `tools/mirror-framer.mjs`, prefer it for this step:

```bash
node tools/mirror-framer.mjs <url> --out mirror --name <slug> --max-routes 40 --route-concurrency 3 --asset-concurrency 12
python3 -m http.server 4177 --directory mirror/<slug>/site
```

Use higher concurrency only when the target tolerates it. `--route-concurrency 3-4` and `--asset-concurrency 12-16` are usually enough.

## GSAP Porting Guidance

Do not port to GSAP by default. A raw mirror preserves Framer motion most closely because it keeps Framer's own runtime. Use GSAP only for a clean, editable rebuild when the user needs custom control, maintainability, or motion beyond what copied Framer runtime/css can reasonably expose.

For a GSAP rebuild:

1. Keep the raw mirror as the reference.
2. Extract timing, easing, transforms, scroll triggers, and stagger behavior from runtime inspection and screenshot/video comparison.
3. Recreate motion with GSAP timelines/ScrollTrigger only after layout/assets/fonts are already matching.
4. Verify each section against the mirror with screenshots and interaction checks.

## Workflow (full lifecycle)

The skill supports two end goals: **rebuild** (extract data → write a fresh React/Next/etc. version) and **customize** (extract → preserve the original mirror, swap text/colors/images via a config file). They diverge after Phase 1.

### shared phase 1: extract

```bash
extract-site <url>      # writes ./reference/<slug>/
```

Headed browser scrolls the page, captures animations, harvests assets, dumps DOM + screenshots + tokens. ~60-90s for a typical landing page.

### path A: customize (for indistinguishable visual fidelity)

This is the path when the user wants the result to look identical to the original.

```bash
extract-site init ./reference/<slug> --out ./<project>   # scaffold the customize project
cd <project> && bun install
# edit config.json — fill in your overrides
extract-site build .                                      # apply config → dist/
extract-site watch .                                      # live rebuild loop
```

The output `dist/` IS the original mirror with your strings/colors/images swapped in. Pixel-perfect because nothing about layout, motion, or styling was rebuilt.

### path B: rebuild (auto-transpile to editable react)

```bash
extract-site rebuild ./reference/<slug> --out ./<project>
# optional: --source-mirror ./mirror/.../__mirror   (fallback for fonts extract didn't grab)
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
- font subsets that didn't load during scroll aren't downloaded — use `--source-mirror` to fall back to the original framer mirror if you have it
- the rebuild produces working code, not pixel-perfect 1:1. for true byte-equivalent fidelity, use path A.

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

- **Headed by default.** The user wants to see the browser working. Only go headless if they explicitly pass `--headless` or are running in CI.
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
3. For colors/typography/spacing: import tokens/tokens.css. Don't pick new values.
4. For assets: copy from assets/ — don't regenerate.
5. After each section: screenshot the build, diff against reference/screenshots/sections/NN-*.png, and fix mismatches before moving on.

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
