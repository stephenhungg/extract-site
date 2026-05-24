#!/usr/bin/env bun
// `extract-site build [project-dir] [--strict]`
// `extract-site watch [project-dir]`
//
// thin wrapper around `node customize.mjs` in a project directory scaffolded
// by `extract-site init`. lets the user invoke build/watch from anywhere.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

interface Args { projectDir: string; passthrough: string[] }

function parseArgs(argv: string[]): Args {
  const args = argv.slice(3); // strip [bun, script, "build"|"watch"]
  const positional = args.filter((a) => !a.startsWith("--"));
  const projectDir = path.resolve(process.cwd(), positional[0] ?? ".");
  const passthrough = args.filter((a) => a.startsWith("--"));
  return { projectDir, passthrough };
}

export async function runBuild(extraFlag?: string) {
  const { projectDir, passthrough } = parseArgs(process.argv);
  const customize = path.join(projectDir, "customize.mjs");

  if (!fs.existsSync(customize)) {
    console.error(`[err] no customize.mjs in ${projectDir}`);
    console.error(`      run \`extract-site init <reference>\` first.`);
    process.exit(1);
  }

  const flags = [customize, ...passthrough];
  if (extraFlag && !flags.includes(extraFlag)) flags.push(extraFlag);

  const child = spawn("node", flags, { cwd: projectDir, stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 1));
}

const subcommand = process.argv[2];
if (subcommand === "watch") runBuild("--watch");
else                        runBuild();
