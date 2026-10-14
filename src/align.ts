import { TICKS_NAME, functionName } from "./profile.ts";
import type { ProfileNode } from "./types.ts";

export const MIN_WINDOW = 8;
export const MAX_WINDOW = 64;

export type Alignment = {
  donorIndex: number;
  window: number;
  matchStart: number;
  missing: ProfileNode[];
};

export type Donor = {
  nodes: ProfileNode[];
  sampleIndex: number;
  /** Leaf→root frame ids, excluding (root). Built once per donor. */
  frameIds: number[];
  /** Highest index of processTicksAndRejections in frameIds, or -1. */
  ticksIndex: number;
};

function frameId(node: ProfileNode, frameIdByNode: Map<number, number>): number {
  return frameIdByNode.get(node.id) ?? 0;
}

/** Frame-id array for a donor stack. Excludes the root frame. */
export function prepareDonor(
  nodes: ProfileNode[],
  sampleIndex: number,
  frameIdByNode: Map<number, number>,
): Donor {
  const n = Math.max(0, nodes.length - 1);
  const frameIds = new Array<number>(n);
  let ticksIndex = -1;
  for (let i = 0; i < n; i++) {
    const node = nodes[i]!;
    frameIds[i] = frameId(node, frameIdByNode);
    if (functionName(node) === TICKS_NAME) ticksIndex = i;
  }
  return { nodes, sampleIndex, frameIds, ticksIndex };
}

function rightmostWindowMatch(
  donorIds: number[],
  ticksIndex: number,
  truncIds: number[],
  w: number,
): number {
  if (w === 0 || w > donorIds.length || w > truncIds.length || ticksIndex < 0) return -1;
  const truncStart = truncIds.length - w;
  for (let i = Math.min(donorIds.length - w, ticksIndex - w); i >= 0; i--) {
    let ok = true;
    for (let j = 0; j < w; j++) {
      if (donorIds[i + j] !== truncIds[truncStart + j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

export function alignWithDonor(truncIds: number[], donor: Donor): Alignment | null {
  // Ids are leaf→root and already exclude (root).
  const donorIds = donor.frameIds;
  if (truncIds.length === 0 || donorIds.length === 0) return null;

  const hi = Math.min(MAX_WINDOW, truncIds.length, donorIds.length);
  let bestW = 0;
  let bestStart = -1;

  let lo = MIN_WINDOW;
  let high = hi;
  while (lo <= high) {
    const mid = (lo + high) >> 1;
    const idx = rightmostWindowMatch(donorIds, donor.ticksIndex, truncIds, mid);
    if (idx >= 0) {
      bestW = mid;
      bestStart = idx;
      lo = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  if (bestW < MIN_WINDOW || bestStart < 0) return null;
  if (donor.ticksIndex < bestStart + bestW) return null;
  const missing = donor.nodes.slice(bestStart + bestW, donor.nodes.length - 1);

  return {
    donorIndex: donor.sampleIndex,
    window: bestW,
    matchStart: bestStart,
    missing,
  };
}

export function pickAlignment(
  truncated: ProfileNode[],
  sampleIndex: number,
  donors: Donor[],
  frameIdByNode: Map<number, number>,
): Alignment | null {
  const truncLen = truncated.length - 1;
  if (truncLen <= 0) return null;
  const truncIds = new Array<number>(truncLen);
  for (let i = 0; i < truncLen; i++) truncIds[i] = frameId(truncated[i]!, frameIdByNode);

  let best: Alignment | null = null;
  let bestDist = Infinity;
  for (const donor of donors) {
    const alignment = alignWithDonor(truncIds, donor);
    if (!alignment) continue;
    const dist = Math.abs(donor.sampleIndex - sampleIndex);
    if (
      !best ||
      alignment.window > best.window ||
      (alignment.window === best.window && dist < bestDist)
    ) {
      best = alignment;
      bestDist = dist;
    }
  }
  return best;
}
