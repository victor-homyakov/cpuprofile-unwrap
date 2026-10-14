import { cloneCallFrame } from "./profile.ts";
import type { CpuProfile, ProfileNode } from "./types.ts";

/**
 * Insert head (leaf→root, including root) with `middle` spliced in before root.
 * Reuses children with the same interned call-frame id. Returns the leaf node id.
 */
export function ensurePath(
  profile: CpuProfile,
  nodesById: Map<number, ProfileNode>,
  childrenByKey: Map<number, Map<number, number>>,
  nextId: { value: number },
  frameIdByNode: Map<number, number>,
  head: readonly ProfileNode[],
  middle: readonly ProfileNode[],
): number {
  if (head.length === 0) {
    throw new Error("empty stack");
  }
  const root = head[head.length - 1]!;
  const headFrames = head.length - 1;
  let currentId = root.id;

  // Walk root → leaf. Virtual sequence is head without root, then middle, then root.
  for (let i = headFrames + middle.length - 1; i >= 0; i--) {
    const frameNode = i < headFrames ? head[i]! : middle[i - headFrames]!;
    const key = frameIdByNode.get(frameNode.id);
    if (key === undefined) {
      throw new Error(`no frame id for node ${frameNode.id}`);
    }
    let byKey = childrenByKey.get(currentId);
    if (!byKey) {
      byKey = new Map();
      const parent = nodesById.get(currentId)!;
      for (const cid of parent.children ?? []) {
        const child = nodesById.get(cid);
        const childKey = child && frameIdByNode.get(child.id);
        if (childKey !== undefined) byKey.set(childKey, cid);
      }
      childrenByKey.set(currentId, byKey);
    }
    const existing = byKey.get(key);
    if (existing !== undefined) {
      currentId = existing;
      continue;
    }
    const id = nextId.value++;
    const created: ProfileNode = {
      id,
      callFrame: cloneCallFrame(frameNode.callFrame),
      hitCount: 0,
      children: [],
    };
    profile.nodes.push(created);
    nodesById.set(id, created);
    frameIdByNode.set(id, key);
    const parent = nodesById.get(currentId)!;
    if (!parent.children) parent.children = [];
    parent.children.push(id);
    byKey.set(key, id);
    childrenByKey.set(id, new Map());
    currentId = id;
  }
  return currentId;
}

export function recomputeHitCounts(profile: CpuProfile): void {
  const counts = new Map<number, number>();
  for (const sample of profile.samples) {
    counts.set(sample, (counts.get(sample) ?? 0) + 1);
  }
  for (const node of profile.nodes) {
    node.hitCount = counts.get(node.id) ?? 0;
  }
}

export function pruneUnreachable(profile: CpuProfile, rootId: number): void {
  const parent = new Map<number, number>();
  for (const node of profile.nodes) {
    for (const c of node.children ?? []) parent.set(c, node.id);
  }
  const keep = new Set<number>([rootId]);
  for (const leaf of profile.samples) {
    let id: number | undefined = leaf;
    const seen = new Set<number>();
    while (id !== undefined && !seen.has(id)) {
      seen.add(id);
      keep.add(id);
      id = parent.get(id);
    }
  }
  profile.nodes = profile.nodes.filter((n) => keep.has(n.id));
  for (const node of profile.nodes) {
    if (node.children) {
      node.children = node.children.filter((id) => keep.has(id));
    }
  }
}
