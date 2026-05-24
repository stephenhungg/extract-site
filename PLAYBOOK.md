# Framer Reverse-Engineering Playbook

> Agent-facing playbook for cloning a deployed Framer site into an editable
> Next.js + Tailwind + GSAP (or Vite + React + framer-motion) landing page at
> high fidelity. Read end-to-end before touching a target.
>
> **Self-contained:** every tool this doc tells you to run ships inside this
> skill (`extract-site`, `probe.mjs`, `motion-probe.mjs`). The oracle you verify
> against is the **live original URL** — there is no separate "mirror" to build.

This documents the `extract-site` skill. Everything here is runnable with only
the skill installed. Where a step shows recovered numbers (durations, easings,
diff counts), they are **examples from past builds (angel/kali/yuya) — measure
your own; never reuse them literally.**

---

## 0. The only decision: this is an editable rebuild

There is one path: **extract the live site into a `reference/` folder, then
rebuild it as editable code, verifying each section against the live URL.**

Do **not** mirror Framer's runtime (copy its html/js and swap strings). That path
is a dead end — you end up string-matching against minified hashes that change
every Framer build ("hostage situation"), patching content twice to race
hydration, and shipping a 100MB+ bundle you can't maintain. Always rebuild clean.

**State the fidelity ceiling to the user up front: ~85–95%, never byte-perfect.**
Fonts render slightly differently, spring physics are inferred not measured,
pseudo-elements (`::before`/`::after`) aren't captured, and computed styles are
captured at desktop only (mobile/tablet are screenshot-only). If the user needs
literally indistinguishable, tell them a clean rebuild can't guarantee it.

---

## 1. The core principle: two oracles that check each other

Fidelity does **not** come from screenshots OR DOM/CSS alone. Use both as ground
truth for the axes the other is blind to, and treat disagreement as signal.

**DOM/CSS is ground truth for measurable values + behavior:**
- exact computed values: `width: 437.5px`, the real `matrix(...)`, the actual
  `cubic-bezier(0.44,0,0.56,1)` and `duration: 600` off the browser's animation
  engine
- declarative intent: the literal `{ scale: 1.05 }` read from React fiber
- *behavior*: pinned vs static vs parallax — a screenshot literally cannot tell
  you this; only sampling transforms across scroll and regressing can

**Screenshots are ground truth for what DOM/CSS misses or lies about:**
- pseudo-elements (`::before`/`::after`) — invisible to a `children` DFS walk, but
  they paint
- the actual composited result: backdrop filters, blend modes, z-stacking,
  sub-pixel font rendering. computed style says what was *requested*; the
  screenshot shows what the GPU *painted*
- per-breakpoint layout (computed styles captured at desktop only; mobile/tablet
  are screenshot-only)

**The verification loop (this replaces "diff against a mirror"):**
1. DOM/CSS *drives* the rebuild — inline exact values + measured timing from the
   `reference/` artifacts so layout/motion are right by construction.
2. **`probe.mjs` verifies static layout numerically** — diff your running rebuild
   against the **live original URL** (§4.1). Iterate until diffs hit single digits.
3. **Screenshots verify what the probe can't see** — diff your rebuild's
   screenshots against `reference/<slug>/screenshots/sections/*.png` at all 3
   viewports (catches pseudo-elements, compositing, mobile).
4. **`motion-probe.mjs` verifies choreography** — screenshot diff is useless for
   motion. Re-run it on your rebuild and compare transform-vs-scrollY against the
   reference capture (§4.2).

When the oracles disagree, that's the bug telling you where it is:
- screenshot off but probe matches → pseudo-element or a font subset that didn't
  load (DOM/CSS blind spot)
- probe differs but it looks fine → harmless override, ignore

Eyeballing converges to ~78% and stalls. The numerical probe loop is what closes
the last gap (§4.1).

---

## 2. Setup (run once, idempotent)

```bash
cd ~/.claude/skills/extract-site
[ -d node_modules ] || bun install
[ -d ~/.cache/ms-playwright/chromium-* ] || bunx playwright install chromium
```

First chromium install downloads ~150MB / 30–90s — expect the pause, it's not hung.

---

## 3. Extract → reference artifacts

```bash
extract-site <url>                              # writes ./reference/<slug>/
extract-site <url> --out ./reference --name <slug>
```

**Always run HEADED. Never pass `--headless`.** Framer's motion libraries
(`motion/react`, GSAP) are rAF + IntersectionObserver driven, and hover/mouse
events need a real rendering context. Under headless, entry reveals, hover specs,
and scroll motion frequently **don't run at all** — you'd capture a site with zero
motion and not know it. extract-site is headed by default; just don't override it.
(Same rule applies to `probe.mjs` and `motion-probe.mjs` — both launch headed; §4.)

This is the ONLY capture step. It produces the ground-truth `reference/` folder.
**These are the exact paths the skill writes — use them; don't guess:**

```
reference/<slug>/
  meta.json  REBUILD.md
  stack/detected.md                  framer-motion? lenis? gsap? next?
  dom/
    full.html                        complete inlined dom, every node has data-cs-id
    computed-styles.json             ~40 props per element, KEYED BY data-cs-id
    appear-effects.json              entrance from-states (opacity:0, translateY…)
    sections/*.html                  per-section subtrees
  motion/
    animations.json                  measured CDP animations (duration/easing/delay)
    motion-specs.md                  human-readable motion cheat sheet (read this)
    per-section.json
    hover.json  hover-fiber.json  hover-thorough.json   hover specs (3 strategies)
    scroll-motion.json               scroll-linked behaviors (pinned/parallax/scrub)
    transitions.json                 section-boundary choreography
  content/
    layouts.json                     bbox + flex specs per element  ← layout source
    sections.json  text.md
  tokens/
    colors.json  typography.json  spacing.json          token VALUES live here
    tokens.css                       :root{} block, ready to import
    css-vars.json  source-vars.css   the site's OWN named --vars (best Tailwind seed)
  assets/
    images/ videos/ fonts/
    manifest.json                    original urls → local paths
    fonts.css                        @font-face (family names guessed from filenames)
  screenshots/
    {desktop,tablet,mobile}-full.png
    sections/NN-*-{desktop,tablet,mobile}.png            ← screenshot oracle
```

> There is **no** `tokens.json` (singular), no root-level `layouts.json`, no
> `motion-patterns.json`. If a step says otherwise, the step is wrong.

After extracting, read `meta.json`, `stack/detected.md`, and `motion/motion-specs.md`
to understand what you're rebuilding.

### Two rebuild routes from here

| Route | Command | Output stack | When |
|---|---|---|---|
| **Auto-transpile** | `extract-site rebuild reference/<slug> --out <proj>` | **Vite + React + framer-motion** | fast first pass, ~95%, you accept the stack |
| **Hand-port** | manual, §5 | **Next.js + Tailwind + GSAP** | the converged path; full control, ships clean |

`extract-site rebuild` does **not** emit Next/Tailwind/GSAP — it scaffolds Vite +
React + framer-motion with per-section HTML template literals. The §5 workflow is
a manual hand-port; there is no command that generates it. Don't conflate them.

After any scaffold: `cd <proj> && bun install && bun run dev` (Vite serves on
`http://localhost:5173`) before any verify step.

---

## 4. Verification tools (both ship in this skill)

### 4.1 `probe.mjs` — numerical CSS parity (the static oracle)

```bash
bun ~/.claude/skills/extract-site/probe.mjs <originalUrl> <rebuildUrl> [outDir]
# e.g.
bun ~/.claude/skills/extract-site/probe.mjs https://moment.framer.photos http://localhost:5173 ./reference/moment
```

Captures rect + ~30 computed props for `h1/h2/h3/p/nav` + `[data-framer-name]` on
**both** the live original and your running rebuild at 1440×900, pairs them in DOM
order, and writes `css-diff.md` + `css-diff.json`. No mirror needed — it just
needs two reachable URLs (the live site and your `localhost` dev server).

**The loop:** run it, open `css-diff.md`, fix the biggest diffs, re-run. Stop when
`totalDiffs` is single digits and the residual is only `fontFamily` generics or
intentional changes. Extend the `SELECTORS` array in `probe.mjs` for target-specific
blocks. Eyeballing got a past build 0/7 elements matching; the probe loop got it
7/9 byte-identical — the probe *is* the fidelity (those counts are illustrative).

### 4.2 `motion-probe.mjs` — scroll-keyframe capture (the motion oracle)

```bash
bun ~/.claude/skills/extract-site/motion-probe.mjs <url> [interval=40] [outFile=/tmp/motion-probe.json]
```

Scrolls in `interval`px steps, waits 2×rAF + settle at each, records per-element
`transform`/`opacity`/`vpTop` keyframes (compressed to changed frames only).
**Run it on the live original AND on your rebuild, then compare** the transform-vs-
scrollY timelines per element. This is how you verify choreography (pins,
parallax, scrubs) — screenshot diffing can't. There is no automated 0–100
"motion score"; you compare the two keyframe sets directly.

> The other root `.mjs` files (`snap-kali*.mjs`, `audit-hero.mjs`, `audit-nav.mjs`)
> are leftover per-project one-offs with hardcoded URLs. Ignore them or copy-edit;
> don't run as-is. `motion-probe.mjs` is the only parameterized motion tool.

---

## 5. The Next.js + Tailwind + GSAP hand-port

The converged workflow. Use the `reference/` artifacts as ground truth, rebuild
section by section, verify each against the live URL before advancing.

### Phase plan

```
Phase 0  read forensics    meta.json, stack/detected.md, motion/motion-specs.md,
                           content/layouts.json, tokens/
Phase 1  scaffold          Next + Tailwind (match the user's preferred versions)
Phase 2  primitives        shared components; seed Tailwind theme from tokens
Phase 3  content schema    typed content / MDX, decoupled from layout
Phase 4  pages             section by section — PARITY GATE per section (4.1 + screenshots)
Phase 5  motion            re-author with MEASURED values from the artifacts
Phase 6  verify            probe.mjs single-digit diffs + motion-probe compare + Lighthouse
Phase 7  deploy / cutover
```

Doctrine (from a real kickoff): *"do not leverage screenshots for recreating —
that is nondeterministic AI slop. use the DOM and log CSS to gather motion info
and recreate it."* I.e. **build from measured DOM/CSS; use screenshots only to
verify.**

### Layout fidelity in Tailwind

Reconstruct from real `bbox` + flex specs in **`content/layouts.json`** and the
per-element values in **`dom/computed-styles.json`** (keyed by `data-cs-id`,
matching `dom/full.html`) — not by eyeballing. Recreate the box model with
Tailwind classes; drop to arbitrary values (`gap-[40px]`, `text-[64px]`) for the
measured exacts. Seed `tailwind.config` (or v4 `@theme`) from **`tokens/colors.json`,
`tokens/spacing.json`, `tokens/typography.json`** — or better, from
**`tokens/css-vars.json`/`source-vars.css`** if the site declares named vars.
**Match the source's real breakpoint count** (read it off the captures; many
Framer sites use 2, not 3 — don't invent a tablet breakpoint that isn't there).

### Motion port — measured values, two engine choices

**Decision rule:** if `stack/detected.md` shows framer-motion **and**
`motion/hover-fiber.json` is non-empty (site ships uncompiled motion props), port
the framer-motion primitives **verbatim** — the authored `{ type:'spring',
bounce:0.2, duration:1.2 }` becomes the literal prop. Otherwise re-author in
**GSAP** from `motion/scroll-motion.json` + a fresh `motion-probe.mjs` run.

Pull every duration/easing from **`motion/motion-specs.md` and `animations.json`**
— do not invent them. Map them:
- scroll reveals → `ScrollTrigger` (or framer-motion `whileInView`), using the
  measured easing from `animations.json`
- entry/loading → timeline gated on `document.fonts.ready` (avoids font-swap jump)
- hover → the spec from `hover-fiber.json` (exact `{ scale, transition }`) or, if
  empty, the computed deltas in `hover-thorough.json`
- scroll-linked (pin/parallax/scrub) → `scroll-motion.json` keyframes, verified
  with `motion-probe.mjs`

*Illustrative recovered specs (DO NOT reuse — measure your own): a hero word-rise
at `yPercent 110→0, expo.out, 0.12 stagger`; a `scale 0.6→1` image zoom; a bg
crossfade scrubbed over a ~1400px window. These were kali's radiance values; your
target's are different.*

### Done-bar (define it numerically, not by feel)

A section is done when: `probe.mjs` diffs for that section's selectors are ≤ a few
(only generic-font or intentional residuals), AND its screenshot matches
`reference/<slug>/screenshots/sections/NN-*.png` at all 3 viewports, AND its
`motion-probe` keyframes track the reference within tolerance.

### Port gotchas (caught in real builds)

- **ScrollTrigger won't fire under Playwright `fullPage` screenshots** (no real
  scroll events) → use `IntersectionObserver` for reveals, and/or add an explicit
  scroll pass to your screenshot script before capturing.
- **SSR/hydration trap:** `gsap.set(...)` that hides content which then never
  animates back (if the trigger doesn't refresh after layout settles). Refresh
  ScrollTrigger after fonts/images load.
- **Don't shortcut entrance `opacity` to 0** → keep `0.001` to hold the GPU
  compositing layer (matches Framer's own trick; avoids a paint pop).
- **Fonts:** they're in `assets/fonts/` with `assets/fonts.css` (`@font-face`
  family names *guessed* from filenames — sanity-check them). If a subset didn't
  load during capture, re-extract with more scrolling, or hand-add the
  `@font-face` / a Google Fonts import. (There is no mirror to fall back to.)
- **IP discipline:** for commercial templates, port the *patterns* (crossfade
  choreography, pinned bridges, parallax wordmarks) with the user's own copy +
  assets. Don't ship the template's verbatim text/imagery.

### Codex coordination (optional)

If using Codex as a second builder: hand it whole sections in its own session
running the same `extract-site` artifacts + a `tasks/todo.md`. If using it as an
adversarial reviewer (`/codex challenge`), sandbox it off `~/.claude/skills`.
Coordinate through shared on-disk artifacts (`reference/`, `tasks/`, commits), not
message-passing.

---

## 6. Capture mechanics (why the artifacts are trustworthy)

You don't need to run these — `extract-site` does. But knowing how each artifact
is produced tells you how far to trust it.

- **`computed-styles.json` / `data-cs-id` spine** — deterministic DFS from
  `document.body` stamps each node `data-cs-id` and dumps ~40 resolved props.
  The same walk re-runs in separate passes (hover, appear) and IDs line up, so
  every artifact addresses the same physical element. *Resolved* values → inline
  exact sizing instead of re-deriving Framer's layout.
- **`animations.json` (measured timing)** — a CDP `Animation.animationStarted`
  listener captures real `duration`/`delay`/`easing`/keyframes on the **first**
  scroll-through (`whileInView`/`once` won't refire). Measured, not parsed.
  Limitation: CDP gives offsets/easings but not transform values, so the *kind*
  is inferred — cross-check with `scroll-motion.json`.
- **`hover-fiber.json` (declarative hover)** — reads React fiber
  (`el.__reactFiber$…`), walks up `.return` ≤6 hops, returns the literal
  `whileHover` prop. Exact intent, no mouse simulation. Empty when the site
  compiled its motion away → fall back to `hover-thorough.json` (mouse-diff).
- **`appear-effects.json` (entrance from-states)** — a second browser
  `addInitScript`s a no-op `IntersectionObserver` + no-op `Element.animate`, so
  Framer injects its initial styles but can never animate them away — the page
  freezes pristine and the exact from-state is read.
- **`scroll-motion.json` (scroll-linked)** — samples bbox+transform across scroll
  positions and regresses viewport-top vs scrollY: slope ≈0 pinned, −0.92…−0.08
  parallax, ≈−1 normal flow. The only way to tell a pinned/scrubbed hero from a
  static one.
- **tokens** — prefers the site's own `--vars` (`source-vars.css`/`css-vars.json`)
  over frequency-inferred values.
- **fonts** — caught off the wire, magic-byte validated (Framer serves transcoded
  bytes — jpg URL, webp body), `@font-face` names guessed from filenames.

Known blind spots (carry these to the user): pseudo-elements never walked
(screenshots are the only oracle for them); springs inferred not measured;
computed styles desktop-only; compiled-away motion props defeat fiber reads.

---

## 7. TL;DR for an agent picking this up cold

1. **Setup** (§2): `bun install` + `bunx playwright install chromium`.
2. **Extract** (§3): `extract-site <url>` → `reference/<slug>/`. Read `meta.json`,
   `stack/detected.md`, `motion/motion-specs.md`. Never mirror.
3. **Rebuild**: fast = `extract-site rebuild` (Vite/React/framer-motion); converged
   = hand-port to Next/Tailwind/GSAP (§5). Build from measured DOM/CSS, not
   screenshots. Seed Tailwind from `tokens/` (prefer `source-vars.css`). Match the
   real breakpoint count.
4. **Port motion** (§5): framer-motion verbatim if `hover-fiber.json` is non-empty,
   else GSAP from `scroll-motion.json` + `motion-probe.mjs`. Use measured
   durations/easings from `motion-specs.md`/`animations.json`. Never reuse the
   example numbers in this doc.
5. **Verify against the LIVE URL** (§4) — there is no mirror oracle:
   - `bun probe.mjs <liveUrl> <localhost> <outDir>` → iterate `css-diff.md` to
     single-digit diffs
   - screenshot-diff sections vs `reference/<slug>/screenshots/sections/*`
   - `bun motion-probe.mjs` on both, compare timelines
   - section done = probe ≤ few + screenshots match 3 viewports + motion tracks.
6. **Tell the user the ceiling is ~85–95%, never byte-perfect.**
