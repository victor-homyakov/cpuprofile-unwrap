import {
  RUNTIME_ENTRIES,
  SKIP_WHEN_SEEKING_DONOR,
  hasTicks,
  isIdleOrGcStack,
  nearRootName,
  stackNodes,
  type ProfileIndex,
} from "./profile.ts";
import type { ProfileNode } from "./types.ts";

export type SampleInfo = {
  index: number;
  leafId: number;
  nodes: ProfileNode[];
  depth: number;
  nearRoot: string;
  ticks: boolean;
  idleOrGc: boolean;
  structuralCandidate: boolean;
};

export function analyzeSamples(index: ProfileIndex): {
  samples: SampleInfo[];
  maxDepth: number;
  depthThreshold: number;
} {
  const samples: SampleInfo[] = index.profile.samples.map((leafId, i) => {
    const nodes = stackNodes(index, leafId);
    const nearRoot = nearRootName(nodes);
    return {
      index: i,
      leafId,
      nodes,
      depth: nodes.length,
      nearRoot,
      ticks: hasTicks(nodes),
      idleOrGc: isIdleOrGcStack(nodes),
      structuralCandidate: !RUNTIME_ENTRIES.has(nearRoot),
    };
  });

  let maxDepth = 0;
  for (const s of samples) {
    if (s.depth > maxDepth) maxDepth = s.depth;
  }
  const depthThreshold =
    maxDepth >= 80 ? Math.max(80, Math.floor(0.75 * maxDepth)) : 1;

  for (const s of samples) {
    s.structuralCandidate =
      s.structuralCandidate && s.depth >= depthThreshold;
  }

  return { samples, maxDepth, depthThreshold };
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
