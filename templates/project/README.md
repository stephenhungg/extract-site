# PROJECT_NAME

Customizable mirror of REFERENCE_URL. Scaffolded by `extract-site init`.

## structure

```
mirror/                   pristine runtime mirror — never edit
config.json               your overrides (replace side)
template-baseline.json    original strings (find side)
overrides.css             css patches injected into <head>
customize.mjs             the build pipeline
dist/                     output, ready to serve
```

## quick start

```bash
bun install                  # cheerio + chokidar
bun run build                # apply config → dist/
bun run build:strict         # exits non-zero on slot drift (use in CI)
bun run watch                # live rebuild on config / css / baseline changes
bun run serve                # serve dist/ at http://127.0.0.1:4188
```

## how it works

`customize.mjs` walks every leaf string in `template-baseline.json` and
replaces it with the matching leaf at the same path in `config.json` (if any).
So if your baseline is:

```json
{ "site": { "title": "Original Site" } }
```

…and your config is:

```json
{ "site": { "title": "My New Site" } }
```

…then "Original Site" is replaced with "My New Site" wherever it appears in
`mirror/`.

Color tokens under `theme.colors` get expanded into both `#hex` and `rgb()`
forms automatically. Image filename rewrites under `images.replacements`
work the same way.

For project-specific HTML surgery (mailto links, post-hydration injections,
etc.), edit the `patchHtml` function in `customize.mjs` — it has cheerio
loaded against `dist/index.html`.

## strict mode

`bun run build:strict` exits non-zero if any slot fails to find its baseline
string in the mirror. Use this to catch drift the moment the upstream mirror
changes — by default the build only warns, it doesn't abort.

## adding new slots

Just add a leaf to both `template-baseline.json` AND `config.json` at the
same path. Example:

```json
// template-baseline.json
{ "hero": { "headline": "Welcome" } }

// config.json
{ "hero": { "headline": "Hi there" } }
```

That generates a slot named `hero.headline` that replaces "Welcome" with
"Hi there" everywhere it appears. Use `--strict` to verify it actually
matched something in the mirror.
