#!/usr/bin/env bun
// `extract-site init <reference-dir> [--out <project-dir>] [--name <slug>] [--mirror <path>]`
//
// scaffolds a customize-pipeline project from a reference dir produced by
// `extract-site <url>`. produces:
//   <project>/mirror/                 ← copied or symlinked from <reference>/dom/
//   <project>/customize.mjs           ← generic pipeline (cheerio + slot registry + watch + strict)
//   <project>/config.json             ← starter, with site.title pre-filled if extractable
//   <project>/template-baseline.json  ← starter, baseline strings pre-populated from content/text
//   <project>/overrides.css           ← starter
//   <project>/package.json            ← bun-friendly scripts
//   <project>/README.md               ← usage
//   <project>/.gitignore

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(__dirname, "..");
const TPL_DIR   = path.join(SKILL_DIR, "templates", "project");

interface Args {
  reference: string;
  out: string;
  name: string;
  mirrorOverride?: string;
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(3); // strip [bun, script, "init"]
  const positional = args.filter((a) => !a.startsWith("--") && !args[args.indexOf(a) - 1]?.startsWith("--"));
  const reference = positional[0];
  if (!reference) {
    console.error("Usage: extract-site init <reference-dir> [--out <project-dir>] [--name <slug>] [--mirror <path>]");
    process.exit(1);
  }
  const get = (k: string) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const refResolved = path.resolve(process.cwd(), reference);
  const fallbackName = path.basename(refResolved).replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "project";
  const name = get("name") ?? fallbackName;
  const out  = path.resolve(process.cwd(), get("out") ?? `${fallbackName}-customized`);
  return { reference: refResolved, out, name, mirrorOverride: get("mirror") };
}

function readJsonSafe(p: string): unknown {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

// pull a starter baseline from whatever the extractor produced.
// content.json is the richest source (text + headings + buttons).
function buildBaseline(referenceDir: string): Record<string, unknown> {
  const baseline: Record<string, unknown> = {
    _comment: "Auto-populated from extracted content. Strings here are the FIND side; mirror values from your config.json by matching path.",
  };

  const meta = readJsonSafe(path.join(referenceDir, "meta.json")) as Record<string, unknown> | null;
  if (meta) {
    baseline.site = {
      title: meta.title ?? "",
      description: (meta as { description?: string }).description ?? "",
    };
  }

  const content = readJsonSafe(path.join(referenceDir, "content", "content.json"))
                ?? readJsonSafe(path.join(referenceDir, "content.json"));
  if (content && typeof content === "object") {
    // best-effort: surface common framer-style fields if extractor named them
    const c = content as Record<string, unknown>;
    if (Array.isArray(c.headings) && c.headings.length > 0) {
      const h1 = (c.headings as { level: number; text: string }[]).find((h) => h.level === 1);
      if (h1) baseline.hero = { ...(baseline.hero as object ?? {}), h1: h1.text };
    }
  }

  return baseline;
}

function buildConfig(referenceDir: string): Record<string, unknown> {
  const baseline = buildBaseline(referenceDir);
  // mirror baseline shape with empty strings — user fills in
  const cfg: Record<string, unknown> = {
    _comment: "Your overrides. Each leaf string here that matches a leaf in template-baseline.json (by path) becomes a replacement slot.",
  };
  if (baseline.site && typeof baseline.site === "object") {
    cfg.site = { title: "REPLACE_ME", description: "REPLACE_ME" };
  }
  cfg.theme = {
    colors: { _comment: "{ '#oldHex': '#newHex' } — both hex and rgb() forms auto-expanded" },
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
    textTransform: "none",
  };
  cfg.images = {
    _comment: "assets: { destFileName: srcRelToProject } — copies into dist/<dirs[i]>/. dirs defaults to ['images'].",
    dirs: ["images"],
    assets: {},
    replacements: { _comment: "{ originalCdnFilename: newFilename } — rewrites refs in the html/js bundle" },
  };
  return cfg;
}

function copyTemplate(src: string, dst: string, replacements: Record<string, string>) {
  let content = fs.readFileSync(src, "utf8");
  for (const [k, v] of Object.entries(replacements)) {
    content = content.replaceAll(k, v);
  }
  fs.writeFileSync(dst, content);
}

function copyMirror(referenceDir: string, projectDir: string, mirrorOverride?: string) {
  const dest = path.join(projectDir, "mirror");
  // priority: --mirror override → reference/dom/full.html neighbor → reference/raw-mirror → just dom/
  if (mirrorOverride) {
    const src = path.resolve(process.cwd(), mirrorOverride);
    if (!fs.existsSync(src)) throw new Error(`--mirror path not found: ${mirrorOverride}`);
    fs.cpSync(src, dest, { recursive: true });
    return { source: mirrorOverride, kind: "override" as const };
  }
  // common patterns the extractor produces
  const candidates = [
    path.join(referenceDir, "raw-mirror"),
    path.join(referenceDir, "mirror"),
    path.join(referenceDir, "dom"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isDirectory()) {
      fs.cpSync(c, dest, { recursive: true });
      return { source: c, kind: "auto" as const };
    }
  }
  // last resort: write a stub so customize.mjs gives a clear error
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(
    path.join(dest, "README.txt"),
    "this mirror/ dir is empty.\n" +
    "drop your raw runtime mirror here, or re-run init with --mirror <path>.\n"
  );
  return { source: null, kind: "empty" as const };
}

async function main() {
  const { reference, out, name, mirrorOverride } = parseArgs(process.argv);

  if (!fs.existsSync(reference)) {
    console.error(`[err] reference dir not found: ${reference}`);
    process.exit(1);
  }
  if (fs.existsSync(out) && fs.readdirSync(out).length > 0) {
    console.error(`[err] output dir is not empty: ${out}`);
    console.error(`      delete it first, or pass --out <other-dir>`);
    process.exit(1);
  }
  fs.mkdirSync(out, { recursive: true });

  console.log(`\n📦 extract-site init`);
  console.log(`   reference: ${reference}`);
  console.log(`   out:       ${out}`);
  console.log(`   name:      ${name}\n`);

  // 1. mirror
  const mirror = copyMirror(reference, out, mirrorOverride);
  if (mirror.kind === "empty") {
    console.warn(`   ⚠ no mirror found in reference. wrote stub at mirror/README.txt`);
  } else {
    console.log(`   ✓ mirror copied from ${mirror.source}`);
  }

  // 2. baseline + config (auto-populated)
  fs.writeFileSync(
    path.join(out, "template-baseline.json"),
    JSON.stringify(buildBaseline(reference), null, 2) + "\n"
  );
  fs.writeFileSync(
    path.join(out, "config.json"),
    JSON.stringify(buildConfig(reference), null, 2) + "\n"
  );
  console.log(`   ✓ template-baseline.json + config.json scaffolded`);

  // 3. overrides.css, customize.mjs, .gitignore — straight copies
  fs.cpSync(path.join(TPL_DIR, "overrides.css"), path.join(out, "overrides.css"));
  fs.cpSync(path.join(TPL_DIR, "customize.mjs"), path.join(out, "customize.mjs"));
  fs.cpSync(path.join(TPL_DIR, ".gitignore"), path.join(out, ".gitignore"));
  console.log(`   ✓ overrides.css, customize.mjs, .gitignore copied`);

  // 4. package.json + README — interpolated
  copyTemplate(
    path.join(TPL_DIR, "package.json"),
    path.join(out, "package.json"),
    { PROJECT_NAME: name }
  );
  copyTemplate(
    path.join(TPL_DIR, "README.md"),
    path.join(out, "README.md"),
    { PROJECT_NAME: name, REFERENCE_URL: (readJsonSafe(path.join(reference, "meta.json")) as { url?: string } | null)?.url ?? "<reference url>" }
  );
  console.log(`   ✓ package.json + README.md generated\n`);

  console.log(`✅ project scaffolded at ${out}`);
  console.log(``);
  console.log(`next steps:`);
  console.log(`  cd ${path.relative(process.cwd(), out) || "."}`);
  console.log(`  bun install`);
  console.log(`  # edit config.json — fill in REPLACE_ME values`);
  console.log(`  bun run build`);
  console.log(`  bun run serve`);
}

main().catch((e) => {
  console.error("[err]", e.message);
  process.exit(1);
});
