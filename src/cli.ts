#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { formatStats, unwrapProfile } from "./unwrap.ts";
import type { CpuProfile } from "./types.ts";

function usage(): never {
  console.error(`Usage: cpuprofile-unwrap <input.cpuprofile> -o <output.cpuprofile> [--stats]

Detect truncated V8/Node CPU profile stacks and restore the missing outer frames.`);
  process.exit(2);
}

function parseArgs(argv: string[]): {
  input: string;
  output: string;
  stats: boolean;
} {
  const rest = argv.slice(2);
  let input: string | undefined;
  let output: string | undefined;
  let stats = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "-o" || arg === "--output") {
      output = rest[++i];
    } else if (arg === "--stats") {
      stats = true;
    } else if (arg === "-h" || arg === "--help") {
      usage();
    } else if (arg.startsWith("-")) {
      console.error(`Unknown option: ${arg}`);
      usage();
    } else if (!input) {
      input = arg;
    } else {
      console.error(`Unexpected argument: ${arg}`);
      usage();
    }
  }
  if (!input || !output) usage();
  return { input, output, stats };
}

function main(): void {
  const { input, output, stats } = parseArgs(process.argv);
  const profile = JSON.parse(readFileSync(input, "utf8")) as CpuProfile;
  const result = unwrapProfile(profile);
  writeFileSync(output, JSON.stringify(result.profile));
  if (stats) {
    console.error(formatStats(result.stats));
  }
}

main();
