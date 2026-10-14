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

type NodeFacts = {
  depth: Map<number, number>;
  nearRoot: Map<number, string>;
  ticks: Map<number, boolean>;
  idleOrGc: Map<number, boolean>;
};

/** Depth, near-root name, and ticks/idle flags via the parent chain. Each node is visited once. */
function nodeFacts(index: ProfileIndex): NodeFacts {
  const depth = new Map<number, number>();
  const nearRoot = new Map<number, string>();
  const ticks = new Map<number, boolean>();
  const idleOrGc = new Map<number, boolean>();
  const { parent, nodesById } = index;

  const ensure = (start: number): void => {
    const chain: number[] = [];
    const seen = new Set<number>();
    let cur: number | undefined = start;
    while (cur !== undefined && !depth.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      chain.push(cur);
      cur = parent.get(cur);
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      const id = chain[i]!;
      if (depth.has(id)) continue;
      const node = nodesById.get(id);
      if (!node) {
        depth.set(id, 0);
        nearRoot.set(id, "");
        ticks.set(id, false);
        idleOrGc.set(id, false);
        continue;
      }
      const name = functionName(node);
      const p = parent.get(id);
      const pDepth = p === undefined ? undefined : depth.get(p);
      if (pDepth === undefined) {
        depth.set(id, 1);
        nearRoot.set(id, name);
        ticks.set(id, name === TICKS_NAME);
        idleOrGc.set(id, IDLE_OR_GC.has(name));
      } else {
        depth.set(id, pDepth + 1);
        nearRoot.set(id, pDepth === 1 ? name : nearRoot.get(p!)!);
        ticks.set(id, ticks.get(p!)! || name === TICKS_NAME);
        idleOrGc.set(id, idleOrGc.get(p!)! || IDLE_OR_GC.has(name));
      }
    }
  };

  for (const leafId of index.profile.samples) ensure(leafId);
  return { depth, nearRoot, ticks, idleOrGc };
}

export function analyzeSamples(index: ProfileIndex): {
  samples: SampleInfo[];
  maxDepth: number;
  depthThreshold: number;
} {
  const facts = nodeFacts(index);
  let maxDepth = 0;
  const samples: SampleInfo[] = index.profile.samples.map((leafId, i) => {
    const depth = facts.depth.get(leafId) ?? 0;
    if (depth > maxDepth) maxDepth = depth;
    const near = facts.nearRoot.get(leafId) ?? "";
    return {
      index: i,
      leafId,
      nodes: null,
      depth,
      nearRoot: near,
      ticks: facts.ticks.get(leafId) ?? false,
      idleOrGc: facts.idleOrGc.get(leafId) ?? false,
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
