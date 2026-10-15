import {
  RUNTIME_ENTRIES,
  SKIP_WHEN_SEEKING_DONOR,
  TICKS_NAME,
  functionName,
  stackNodes,
  type ProfileIndex,
} from "./profile.ts";
import type { ProfileNode } from "./types.ts";

export type SampleInfo = {
  index: number;
  leafId: number;
  depth: number;
  nearRoot: string;
  ticks: boolean;
  structuralCandidate: boolean;
};

type NodeFact = {
  depth: number;
  nearRoot: string;
  ticks: boolean;
};

/** Depth, near-root name, and ticks flag via the parent chain. Each node is visited once. */
function nodeFacts(index: ProfileIndex): Array<NodeFact | undefined> {
  const { parentOf, nodeAt } = index;
  const facts: Array<NodeFact | undefined> = new Array(parentOf.length);
  const chain: number[] = [];
  const seen = new Set<number>();

  const parentIdOf = (id: number): number =>
    id > 0 && id < parentOf.length ? parentOf[id]! : 0;

  const ensure = (start: number): void => {
    if (start <= 0 || start >= facts.length || facts[start] !== undefined) return;
    chain.length = 0;
    seen.clear();
    let cur = start;
    while (cur !== 0 && facts[cur] === undefined && !seen.has(cur)) {
      seen.add(cur);
      chain.push(cur);
      cur = parentIdOf(cur);
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      const id = chain[i]!;
      const node = nodeAt[id];
      if (!node) {
        facts[id] = { depth: 0, nearRoot: "", ticks: false };
        continue;
      }
      const name = functionName(node);
      const parentId = parentIdOf(id);
      const parentFact = parentId === 0 ? undefined : facts[parentId];
      facts[id] = {
        depth: parentFact ? parentFact.depth + 1 : 1,
        nearRoot: !parentFact || parentFact.depth === 1 ? name : parentFact.nearRoot,
        ticks: (parentFact?.ticks ?? false) || name === TICKS_NAME,
      };
    }
  };

  for (const leafId of index.profile.samples) ensure(leafId);
  return facts;
}

export function analyzeSamples(index: ProfileIndex): {
  samples: SampleInfo[];
  maxDepth: number;
  depthThreshold: number;
} {
  const facts = nodeFacts(index);
  let maxDepth = 0;
  const samples: SampleInfo[] = index.profile.samples.map((leafId, i) => {
    const fact = leafId > 0 && leafId < facts.length ? facts[leafId] : undefined;
    const depth = fact?.depth ?? 0;
    if (depth > maxDepth) maxDepth = depth;
    return {
      index: i,
      leafId,
      depth,
      nearRoot: fact?.nearRoot ?? "",
      ticks: fact?.ticks ?? false,
      structuralCandidate: false,
    };
  });

  const depthThreshold =
    maxDepth >= 80 ? Math.max(80, Math.floor(0.75 * maxDepth)) : 1;

  for (const s of samples) {
    s.structuralCandidate =
      s.depth >= depthThreshold && !RUNTIME_ENTRIES.has(s.nearRoot);
  }

  return { samples, maxDepth, depthThreshold };
}

/** Materialize a sample stack, sharing the array across samples with the same leaf. */
export function bindSampleNodes(
  index: ProfileIndex,
): (sample: SampleInfo) => ProfileNode[] {
  const cache = new Map<number, ProfileNode[]>();
  return (sample) => {
    let nodes = cache.get(sample.leafId);
    if (!nodes) {
      nodes = stackNodes(index, sample.leafId);
      cache.set(sample.leafId, nodes);
    }
    return nodes;
  };
}

/** Consecutive structural candidates, ignoring idle/GC gaps in neighbor search only. */
export function candidateRuns(samples: SampleInfo[]): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let start: number | null = null;
  let last = -1;
  for (const s of samples) {
    if (s.structuralCandidate) {
      if (start === null) start = s.index;
      last = s.index;
    } else if (!SKIP_WHEN_SEEKING_DONOR.has(s.nearRoot) && start !== null) {
      runs.push([start, last]);
      start = null;
    }
  }
  if (start !== null) runs.push([start, last]);
  return runs;
}

export function nearestTicksNeighbors(
  samples: SampleInfo[],
  runStart: number,
  runEnd: number,
): { prev: SampleInfo[]; next: SampleInfo[] } {
  const limit = 5;
  const maxLook = 128;
  const prev: SampleInfo[] = [];
  let looked = 0;
  for (let i = runStart - 1; i >= 0 && looked < maxLook && prev.length < limit; i--) {
    const s = samples[i]!;
    if (SKIP_WHEN_SEEKING_DONOR.has(s.nearRoot)) continue;
    looked++;
    if (s.ticks) prev.push(s);
  }
  const next: SampleInfo[] = [];
  looked = 0;
  for (let i = runEnd + 1; i < samples.length && looked < maxLook && next.length < limit; i++) {
    const s = samples[i]!;
    if (SKIP_WHEN_SEEKING_DONOR.has(s.nearRoot)) continue;
    looked++;
    if (s.ticks) next.push(s);
  }
  return { prev, next };
}
