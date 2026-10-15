import { pickAlignment, prepareDonor } from "./align.ts";
import {
  analyzeSamples,
  bindSampleNodes,
  candidateRuns,
  nearestTicksNeighbors,
} from "./detect.ts";
import {
  ROOT_NAME,
  RUNTIME_ENTRIES,
  buildIndex,
  functionName,
} from "./profile.ts";
import {
  ensurePath,
  pruneUnreachable,
  recomputeHitCounts,
  type PathCursor,
  type ProfileTree,
} from "./repair.ts";
import type { CpuProfile, ProfileNode, UnwrapStats } from "./types.ts";

export type UnwrapResult = {
  profile: CpuProfile;
  stats: UnwrapStats;
};

function rootChildNames(
  profile: CpuProfile,
  nodeAt: (id: number) => ProfileNode | undefined,
): string[] {
  const root = profile.nodes.find((n) => functionName(n) === ROOT_NAME) ?? profile.nodes[0];
  if (!root) return [];
  return (root.children ?? []).map((id) => {
    const node = nodeAt(id);
    return node ? functionName(node) : `#${id}`;
  });
}

export function unwrapProfile(profile: CpuProfile): UnwrapResult {
  const index = buildIndex(profile);
  const { samples, maxDepth, depthThreshold } = analyzeSamples(index);
  const loadNodes = bindSampleNodes(index);
  const rootChildrenBefore = rootChildNames(profile, (id) => index.nodeAt[id]);
  let samplesWithTicksBefore = 0;
  let candidateCount = 0;
  for (const sample of samples) {
    if (sample.ticks) samplesWithTicksBefore++;
    if (sample.structuralCandidate) candidateCount++;
  }

  const nodesById = new Map(profile.nodes.map((n) => [n.id, n]));
  const childrenByKey = new Map<number, Map<number, number>>();
  let maxId = 0;
  for (const node of profile.nodes) {
    if (node.id > maxId) maxId = node.id;
  }
  const tree: ProfileTree = {
    profile,
    nodesById,
    childrenByKey,
    nextId: maxId + 1,
    frameIdByNode: index.frameIdByNode,
  };

  const pathCursor: PathCursor = { frames: [], nodeIds: [] };
  const cutNames: Record<string, number> = {};
  let repairedCount = 0;
  let skippedCount = 0;
  let samplesWithTicksAfter = samplesWithTicksBefore;

  const runs = candidateRuns(samples);
  for (const [runStart, runEnd] of runs) {
    const { prev, next } = nearestTicksNeighbors(samples, runStart, runEnd);
    const donors = [...prev, ...next].map((s) =>
      prepareDonor(loadNodes(s), s.index, index.frameIdByNode),
    );

    for (let i = runStart; i <= runEnd; i++) {
      const sample = samples[i]!;
      if (!sample.structuralCandidate) continue;

      const nodes = loadNodes(sample);
      const alignment = pickAlignment(nodes, sample.index, donors, index.frameIdByNode);
      if (!alignment) {
        skippedCount++;
        continue;
      }

      cutNames[sample.nearRoot] = (cutNames[sample.nearRoot] ?? 0) + 1;
      const leafId = ensurePath(tree, nodes, alignment.missing, pathCursor);
      profile.samples[i] = leafId;
      repairedCount++;
      if (!sample.ticks) samplesWithTicksAfter++;
    }
  }

  recomputeHitCounts(profile);
  pruneUnreachable(profile, index.rootId);

  const stats: UnwrapStats = {
    sampleCount: samples.length,
    maxDepth,
    depthThreshold,
    candidateCount,
    repairedCount,
    skippedCount,
    cutNames,
    rootChildrenBefore,
    rootChildrenAfter: rootChildNames(profile, (id) => nodesById.get(id)),
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
