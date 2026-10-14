import { TICKS_NAME, callFrameKey, functionName } from "./profile.ts";
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
  /** Leaf→root keys, excluding (root). Built once per donor. */
  keys: string[];
};

function frameKey(node: ProfileNode, frameKeyByNode: Map<number, string>): string {
  return frameKeyByNode.get(node.id) ?? callFrameKey(node.callFrame);
}

/** Key array for a donor stack. Excludes the root frame. */
export function prepareDonor(
  nodes: ProfileNode[],
  sampleIndex: number,
  frameKeyByNode: Map<number, string>,
): Donor {
  const n = Math.max(0, nodes.length - 1);
  const keys = new Array<string>(n);
  for (let i = 0; i < n; i++) keys[i] = frameKey(nodes[i]!, frameKeyByNode);
  return { nodes, sampleIndex, keys };
}

function rightmostWindowMatch(
  donorKeys: string[],
  donorNodes: ProfileNode[],
  ngram: string[],
): number {
  const w = ngram.length;
  if (w === 0 || w > donorKeys.length) return -1;
  for (let i = donorKeys.length - w; i >= 0; i--) {
    let ok = true;
    for (let j = 0; j < w; j++) {
      if (donorKeys[i + j] !== ngram[j]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const hasTicksAfter = donorNodes
      .slice(i + w)
      .some((n) => functionName(n) === TICKS_NAME);
    if (hasTicksAfter) return i;
  }
  return -1;
}

export function alignWithDonor(truncKeys: string[], donor: Donor): Alignment | null {
  // Keys are leaf→root and already exclude (root).
  const donorKeys = donor.keys;
  if (truncKeys.length === 0 || donorKeys.length === 0) return null;

  const hi = Math.min(MAX_WINDOW, truncKeys.length, donorKeys.length);
  let bestW = 0;
  let bestStart = -1;

  let lo = MIN_WINDOW;
  let high = hi;
  while (lo <= high) {
    const mid = (lo + high) >> 1;
    const ngram = truncKeys.slice(truncKeys.length - mid);
    const idx = rightmostWindowMatch(donorKeys, donor.nodes, ngram);
    if (idx >= 0) {
      bestW = mid;
      bestStart = idx;
      lo = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  if (bestW < MIN_WINDOW || bestStart < 0) return null;
  const missing = donor.nodes.slice(bestStart + bestW, donor.nodes.length - 1);
  if (!missing.some((n) => functionName(n) === TICKS_NAME)) return null;

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
  frameKeyByNode: Map<number, string>,
): Alignment | null {
  const truncLen = truncated.length - 1;
  if (truncLen <= 0) return null;
  const truncKeys = new Array<string>(truncLen);
  for (let i = 0; i < truncLen; i++) truncKeys[i] = frameKey(truncated[i]!, frameKeyByNode);

  let best: Alignment | null = null;
  let bestDist = Infinity;
  for (const donor of donors) {
    const alignment = alignWithDonor(truncKeys, donor);
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
