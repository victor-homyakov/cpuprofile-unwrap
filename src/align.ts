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

function keysOf(nodes: ProfileNode[]): string[] {
  return nodes.map((n) => callFrameKey(n.callFrame));
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

export function alignWithDonor(
  truncated: ProfileNode[],
  donor: ProfileNode[],
  donorIndex: number,
): Alignment | null {
  // Drop (root) on both sides; work leaf→root.
  const trunc = truncated.slice(0, -1);
  const don = donor.slice(0, -1);
  if (trunc.length === 0 || don.length === 0) return null;

  const truncKeys = keysOf(trunc);
  const donorKeys = keysOf(don);
  const hi = Math.min(MAX_WINDOW, truncKeys.length, donorKeys.length);
  let bestW = 0;
  let bestStart = -1;

  let lo = MIN_WINDOW;
  let high = hi;
  while (lo <= high) {
    const mid = (lo + high) >> 1;
    const ngram = truncKeys.slice(truncKeys.length - mid);
    const idx = rightmostWindowMatch(donorKeys, don, ngram);
    if (idx >= 0) {
      bestW = mid;
      bestStart = idx;
      lo = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  if (bestW < MIN_WINDOW || bestStart < 0) return null;
  const missing = don.slice(bestStart + bestW);
  if (!missing.some((n) => functionName(n) === TICKS_NAME)) return null;

  return {
    donorIndex,
    window: bestW,
    matchStart: bestStart,
    missing,
  };
}

export function pickAlignment(
  truncated: ProfileNode[],
  sampleIndex: number,
  donors: Array<{ nodes: ProfileNode[]; sampleIndex: number }>,
): Alignment | null {
  let best: Alignment | null = null;
  let bestDist = Infinity;
  for (const donor of donors) {
    const alignment = alignWithDonor(truncated, donor.nodes, donor.sampleIndex);
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
