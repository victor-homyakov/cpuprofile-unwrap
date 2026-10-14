import { pickAlignment, prepareDonor } from "./align.ts";
import {
  analyzeSamples,
  candidateRuns,
  nearestTicksNeighbors,
} from "./detect.ts";
import {
  RUNTIME_ENTRIES,
  buildIndex,
  functionName,
  hasTicks,
  stackNodes,
} from "./profile.ts";
import { ensurePath, pruneUnreachable, recomputeHitCounts } from "./repair.ts";
import type { CpuProfile, UnwrapStats } from "./types.ts";

export type UnwrapResult = {
  profile: CpuProfile;
  stats: UnwrapStats;
};

function rootChildNames(profile: CpuProfile): string[] {
  const root = profile.nodes.find((n) => functionName(n) === "(root)") ?? profile.nodes[0];
  if (!root) return [];
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  return (root.children ?? []).map((id) => {
    const n = byId.get(id);
    return n ? functionName(n) : `#${id}`;
  });
}

function countTicksSamples(profile: CpuProfile): number {
  const index = buildIndex(profile);
  let n = 0;
  for (const leaf of profile.samples) {
    if (hasTicks(stackNodes(index, leaf))) n++;
  }
  return n;
}

export function unwrapProfile(profile: CpuProfile): UnwrapResult {
  const index = buildIndex(profile);
  const { samples, maxDepth, depthThreshold } = analyzeSamples(index);
  const rootChildrenBefore = rootChildNames(profile);
  const samplesWithTicksBefore = samples.filter((s) => s.ticks).length;

  const nodesById = new Map(profile.nodes.map((n) => [n.id, n]));
  const childrenByKey = new Map<number, Map<string, number>>();
  let maxId = 0;
  for (const node of profile.nodes) {
    if (node.id > maxId) maxId = node.id;
  }
  const nextId = { value: maxId + 1 };

  const cutNames: Record<string, number> = {};
  let repairedCount = 0;
  let skippedCount = 0;

  const runs = candidateRuns(samples);
  for (const [runStart, runEnd] of runs) {
    const { prev, next } = nearestTicksNeighbors(samples, runStart, runEnd);
    const donors = [...prev, ...next].map((s) =>
      prepareDonor(s.nodes, s.index, index.frameKeyByNode),
    );

    for (let i = runStart; i <= runEnd; i++) {
      const sample = samples[i]!;
      if (!sample.structuralCandidate) continue;

      const alignment = pickAlignment(
        sample.nodes,
        sample.index,
        donors,
        index.frameKeyByNode,
      );
      if (!alignment) {
        skippedCount++;
        continue;
      }

      cutNames[sample.nearRoot] = (cutNames[sample.nearRoot] ?? 0) + 1;
      const inner = sample.nodes.slice(0, -1);
      const full = [...inner, ...alignment.missing, sample.nodes[sample.nodes.length - 1]!];
      const leafId = ensurePath(profile, nodesById, childrenByKey, nextId, full);
      profile.samples[i] = leafId;
      repairedCount++;
    }
  }

  recomputeHitCounts(profile);
  pruneUnreachable(profile, index.rootId);

  const samplesWithTicksAfter = countTicksSamples(profile);

  const stats: UnwrapStats = {
    sampleCount: samples.length,
    maxDepth,
    depthThreshold,
    candidateCount: samples.filter((s) => s.structuralCandidate).length,
    repairedCount,
    skippedCount,
    cutNames,
    rootChildrenBefore,
    rootChildrenAfter: rootChildNames(profile),
    samplesWithTicksBefore,
    samplesWithTicksAfter,
  };

  return { profile, stats };
}

export function formatStats(stats: UnwrapStats): string {
  const cuts = Object.entries(stats.cutNames)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([name, n]) => `  ${n}\t${name}`)
    .join("\n");
  const runtimeAfter = stats.rootChildrenAfter.filter((n) => RUNTIME_ENTRIES.has(n));
  const otherAfter = stats.rootChildrenAfter.filter((n) => !RUNTIME_ENTRIES.has(n));
  return [
    `samples: ${stats.sampleCount}`,
    `maxDepth: ${stats.maxDepth}  threshold: ${stats.depthThreshold}`,
    `candidates: ${stats.candidateCount}  repaired: ${stats.repairedCount}  skipped: ${stats.skippedCount}`,
    `samples with processTicksAndRejections: ${stats.samplesWithTicksBefore} → ${stats.samplesWithTicksAfter}`,
    `root children: ${stats.rootChildrenBefore.length} → ${stats.rootChildrenAfter.length}`,
    `root children after (runtime): ${runtimeAfter.join(", ") || "(none)"}`,
    `root children after (other): ${otherAfter.join(", ") || "(none)"}`,
    cuts ? `cut points:\n${cuts}` : "cut points: (none)",
  ].join("\n");
}
