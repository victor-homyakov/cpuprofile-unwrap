import { cloneCallFrame, nodeKey } from "./profile.ts";
import type { CpuProfile, ProfileNode } from "./types.ts";

/**
 * Insert a leaf→root path (including existing root as last frame) into the tree.
 * Reuses children with the same callFrame key. Returns the leaf node id.
 */
export function ensurePath(
  profile: CpuProfile,
  nodesById: Map<number, ProfileNode>,
  childrenByKey: Map<number, Map<string, number>>,
  nextId: { value: number },
  leafToRoot: ProfileNode[],
): number {
  if (leafToRoot.length === 0) {
    throw new Error("empty stack");
  }
  const root = leafToRoot[leafToRoot.length - 1]!;
  let currentId = root.id;

  // Walk root → leaf (skip the root frame itself).
  for (let i = leafToRoot.length - 2; i >= 0; i--) {
    const frameNode = leafToRoot[i]!;
    const key = nodeKey(frameNode);
    let byKey = childrenByKey.get(currentId);
    if (!byKey) {
      byKey = new Map();
      const parent = nodesById.get(currentId)!;
      for (const cid of parent.children ?? []) {
        const child = nodesById.get(cid);
        if (child) byKey.set(nodeKey(child), cid);
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
