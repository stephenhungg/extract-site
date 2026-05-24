# Agent instructions for this repo

This repo (`extract-site`) reverse-engineers a deployed Framer site into an
editable Next.js + Tailwind + GSAP (or Vite + React + framer-motion) rebuild at
high fidelity.

## Start here

1. **Read [`PLAYBOOK.md`](./PLAYBOOK.md) in full before doing anything.** It is the
   complete method — path selection, the live-URL verification loop, motion
   porting, and the failure modes that waste hours. Do not improvise around it.
2. `SKILL.md` is the Claude Code skill definition (when/how the skill triggers).
3. `README.md` is the human-facing tool overview.

## Non-negotiable rules

- **Run everything HEADED, never `--headless`.** Framer motion libraries
  (`motion/react`, GSAP) are rAF + IntersectionObserver driven and hover needs a
  real render context. Headless silently captures zero motion. Applies to
  `extract-site`, `probe.mjs`, and `motion-probe.mjs`.
- **Never mirror Framer's runtime** (copying its html/js and string-swapping
  content). It's a dead end — minified hashes change every build. Always rebuild
  clean. See PLAYBOOK §0.
- **The oracle is the live original URL**, not a copy. Verify the rebuild by
  diffing it against the live site with `probe.mjs` (PLAYBOOK §4.1).
- **Build from measured DOM/CSS, verify with screenshots** — never the reverse.
- **Don't reuse the example durations/easings/numbers** in the docs — they're
  from past builds (angel/kali/yuya). Measure your own from the `reference/`
  artifacts.
- State the honest fidelity ceiling to the user: **~85–95%, never byte-perfect.**

## Setup (run once)

```bash
bun install
bunx playwright install chromium
```

## The shipped tools (all headed, all parameterized)

- `bin/extract-site <url>` — capture a site into `reference/<slug>/`
- `probe.mjs <originalUrl> <rebuildUrl> [outDir]` — numerical CSS-parity diff
- `motion-probe.mjs <url> [interval] [outFile]` — scroll-keyframe motion capture

If you do nothing else, read the PLAYBOOK and follow its §7 TL;DR.
