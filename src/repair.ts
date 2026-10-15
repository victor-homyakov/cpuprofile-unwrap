import { cloneCallFrame } from "./profile.ts";
import type { CpuProfile, ProfileNode } from "./types.ts";

/** Frame ids and tree node ids of the previous root→leaf insertion, excluding root. */
export type PathCursor = {
  frames: number[];
  nodeIds: number[];
};

/** Profile tree mutated while restored frames are inserted. */
export type ProfileTree = {
  profile: CpuProfile;
  nodesById: Map<number, ProfileNode>;
  childrenByKey: Map<number, Map<number, number>>;
  nextId: number;
  frameIdByNode: Map<number, number>;
};

/**
 * Insert head (leaf→root, including root) with `middle` spliced in before root.
 * Reuses children with the same interned call-frame id. Returns the leaf node id.
 * `cursor` skips the prefix already inserted by the previous call.
 */
export function ensurePath(
  tree: ProfileTree,
  head: readonly ProfileNode[],
  middle: readonly ProfileNode[],
  cursor: PathCursor,
): number {
  const { profile, nodesById, childrenByKey, frameIdByNode } = tree;
  if (head.length === 0) {
    throw new Error("empty stack");
  }
  const root = head[head.length - 1]!;
  const headFrames = head.length - 1;
  const steps = headFrames + middle.length;
  const frames = cursor.frames;
  const nodeIds = cursor.nodeIds;

  const frameAt = (k: number): ProfileNode => {
    const i = steps - 1 - k;
    return i < headFrames ? head[i]! : middle[i - headFrames]!;
  };
  const frameKey = (node: ProfileNode): number => {
    const key = frameIdByNode.get(node.id);
    if (key === undefined) throw new Error(`no frame id for node ${node.id}`);
    return key;
  };

  let currentId = root.id;
  let matched = 0;
  const prevLen = Math.min(frames.length, nodeIds.length);
  while (matched < steps && matched < prevLen) {
    const key = frameKey(frameAt(matched));
    if (key !== frames[matched]) break;
    currentId = nodeIds[matched]!;
    matched++;
  }

  for (let k = matched; k < steps; k++) {
    const frameNode = frameAt(k);
    const key = frameKey(frameNode);
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
    } else {
      const id = tree.nextId++;
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
    frames[k] = key;
    nodeIds[k] = currentId;
  }
  frames.length = steps;
  nodeIds.length = steps;
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
  let maxId = rootId;
  for (const node of profile.nodes) {
    if (node.id > maxId) maxId = node.id;
    for (const c of node.children ?? []) if (c > maxId) maxId = c;
  }
  for (const sample of profile.samples) if (sample > maxId) maxId = sample;

  const parent = new Uint32Array(maxId + 1);
  for (const node of profile.nodes) {
    if (node.id > maxId) continue;
    for (const c of node.children ?? []) {
      if (c > 0 && c <= maxId) parent[c] = node.id;
    }
  }
  const keep = new Uint8Array(maxId + 1);
  if (rootId > 0 && rootId <= maxId) keep[rootId] = 1;
  for (const leaf of profile.samples) {
    let id = leaf;
    while (id > 0 && id <= maxId && keep[id] === 0) {
      keep[id] = 1;
      const next = parent[id]!;
      if (next === id) break;
      id = next;
    }
  }
  profile.nodes = profile.nodes.filter((n) => n.id > 0 && n.id <= maxId && keep[n.id] === 1);
  for (const node of profile.nodes) {
    if (node.children) {
      node.children = node.children.filter((id) => id > 0 && id <= maxId && keep[id] === 1);
    }
  }
}
