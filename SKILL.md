---
name: extract-site
version: 0.1.0
description: |
  Reverse-engineer any website (especially Framer sites) into a structured reference/ folder
  containing static DOM, screenshots, motion specs (durations + easing curves + framer-motion
  props), assets, design tokens, and an auto-generated REBUILD.md prompt — so Claude Code can
  rebuild the site section-by-section with framer-tier polish. Uses a HEADED Chromium so the
  user can watch it work. Use when asked to "extract this site", "reverse engineer this framer",
  "clone this site", "rip motion specs", "get the easing curves", or "give me the design tokens".
triggers:
  - extract this site
  - reverse engineer this site
  - clone this framer site
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

## When to invoke

The user is asking to recreate, clone, or rip apart a deployed website. Most often a Framer site whose motion/taste they want to capture. Also works on any modern site (Webflow, Next, Vercel-hosted, etc.).

**Triggers:** "extract this site", "reverse engineer", "clone this", "rip motion from", "what's the easing on", "get the design tokens from".

## Setup (run once, idempotent)

```bash
cd ~/.claude/skills/extract-site
[ -d node_modules ] || bun install
[ -d ~/.cache/ms-playwright/chromium-* ] || bunx playwright install chromium
```

## Usage

```bash
~/.claude/skills/extract-site/bin/extract-site <url> [--out <dir>] [--name <slug>] [--headless]
```

Defaults:
- `--out` = `./reference` (in current working directory)
- `--name` = auto-derived from URL hostname
- Headed by default. Pass `--headless` to hide the browser.

Examples:
```bash
~/.claude/skills/extract-site/bin/extract-site https://framer.com
~/.claude/skills/extract-site/bin/extract-site https://linear.app --name linear
~/.claude/skills/extract-site/bin/extract-site https://example.framer.website --out ./refs/example
```

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

## Workflow (after running the CLI)

1. **Run the CLI.** Watch the headed browser scroll through, capture animations, harvest assets. Takes ~60-90s for a typical landing page.
2. **Read `REBUILD.md`** — it's pre-filled with everything Claude Code needs.
3. **Hand the folder to Claude Code** with: *"Rebuild this section-by-section. Use the motion specs in `motion/motion-specs.md` exactly — do not invent durations."*
4. **Iterate per section** with the screenshot diff loop (build hero → screenshot → compare → refine → next section).

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
