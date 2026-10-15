import {
  IDLE_OR_GC,
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
  /** Filled on demand for candidates and donors. */
  nodes: ProfileNode[] | null;
  depth: number;
  nearRoot: string;
  ticks: boolean;
  idleOrGc: boolean;
  structuralCandidate: boolean;
};

type NodeFact = {
  depth: number;
  nearRoot: string;
  ticks: boolean;
  idleOrGc: boolean;
};

/** Depth, near-root name, and ticks/idle flags via the parent chain. Each node is visited once. */
function nodeFacts(index: ProfileIndex): Array<NodeFact | undefined> {
  const { parentOf, nodeAt } = index;
  const facts: Array<NodeFact | undefined> = new Array(parentOf.length);

  const parentIdOf = (id: number): number =>
    id > 0 && id < parentOf.length ? parentOf[id]! : 0;

  const ensure = (start: number): void => {
    if (start <= 0 || start >= facts.length) return;
    const chain: number[] = [];
    const seen = new Set<number>();
    let cur = start;
    while (cur !== 0 && facts[cur] === undefined && !seen.has(cur)) {
      seen.add(cur);
      chain.push(cur);
      cur = parentIdOf(cur);
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      const id = chain[i]!;
      if (facts[id] !== undefined) continue;
      const node = nodeAt[id];
      if (!node) {
        facts[id] = { depth: 0, nearRoot: "", ticks: false, idleOrGc: false };
        continue;
      }
      const name = functionName(node);
      const parentId = parentIdOf(id);
      const parentFact = parentId === 0 ? undefined : facts[parentId];
      if (parentFact === undefined) {
        facts[id] = {
          depth: 1,
          nearRoot: name,
          ticks: name === TICKS_NAME,
          idleOrGc: IDLE_OR_GC.has(name),
        };
      } else {
        facts[id] = {
          depth: parentFact.depth + 1,
          nearRoot: parentFact.depth === 1 ? name : parentFact.nearRoot,
          ticks: parentFact.ticks || name === TICKS_NAME,
          idleOrGc: parentFact.idleOrGc || IDLE_OR_GC.has(name),
        };
      }
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
    const near = fact?.nearRoot ?? "";
    return {
      index: i,
      leafId,
      nodes: null,
      depth,
      nearRoot: near,
      ticks: fact?.ticks ?? false,
      idleOrGc: fact?.idleOrGc ?? false,
      structuralCandidate: !RUNTIME_ENTRIES.has(near),
    };
  });

  const depthThreshold =
    maxDepth >= 80 ? Math.max(80, Math.floor(0.75 * maxDepth)) : 1;

  for (const s of samples) {
    s.structuralCandidate =
      s.structuralCandidate && s.depth >= depthThreshold;
  }

  return { samples, maxDepth, depthThreshold };
}

/** Materialize a sample stack, sharing the array across samples with the same leaf. */
export function bindSampleNodes(
  index: ProfileIndex,
): (sample: SampleInfo) => ProfileNode[] {
  const cache = new Map<number, ProfileNode[]>();
  return (sample) => {
    if (sample.nodes) return sample.nodes;
    let nodes = cache.get(sample.leafId);
    if (!nodes) {
      nodes = stackNodes(index, sample.leafId);
      cache.set(sample.leafId, nodes);
    }
    sample.nodes = nodes;
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
  limit = 5,
): { prev: SampleInfo[]; next: SampleInfo[] } {
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
