# PROJECT_NAME

Auto-rebuilt from REFERENCE_URL by `extract-site rebuild`.

## what this is

A **fully editable React app** that reproduces the original Framer site. Each top-level section is its own component, the original Framer CSS is preserved verbatim, animations are driven by framer-motion.

```
src/
  main.tsx                     entry — imports framer-baseline.css + app.css
  App.tsx                      composes sections in order — REORDER HERE
  framer-baseline.css          framer's original css (preserved for layout fidelity)
  app.css                      your overrides
  lib/
    Section.tsx                generic section wrapper (motion + html injection)
  sections/
    01-NAME.tsx                edit the HTML literal to change layout
    02-NAME.tsx
    ...
public/
  images/, fonts/, ...         all assets the original referenced
```

## quick start

```bash
bun install
bun run dev          # http://localhost:5173
bun run build        # → dist/
```

## how to edit

| change | how |
|---|---|
| reorder sections | edit `src/App.tsx` — move imports + JSX |
| remove a section | comment out the import + tag in `App.tsx` |
| add a new section | write `src/sections/NN-NewName.tsx`, import in `App.tsx` |
| change content/layout of a section | open the section file, edit the `HTML` template literal — hot reload picks it up |
| change colors / fonts globally | edit `src/app.css` or override CSS variables in `src/framer-baseline.css` |
| change entry animation | pass `variants` and/or `transition` props to `<Section>` |
| disable entry animation while iterating | pass `static` prop |

## fidelity notes

- **CSS preserved verbatim** — every framer style, custom property, font-face landed in `framer-baseline.css`. Layouts render identically to the original.
- **Animations** — section-level entry by default (slide-up + fade with spring). Per-element framer-motion translation is best-effort; some micro-animations may need manual tuning.
- **Assets** — copied from the extract reference, accessible at `/images/...`, `/fonts/...`.

What's NOT preserved: framer's specific React runtime + chunk hydration code. Replaced with framer-motion + your own component tree.
