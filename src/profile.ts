import type { CallFrame, CpuProfile, ProfileNode } from "./types.ts";

export const TICKS_NAME = "processTicksAndRejections";
export const ROOT_NAME = "(root)";

const IDLE_OR_GC = new Set(["(idle)", "(garbage collector)"]);

export const SKIP_WHEN_SEEKING_DONOR = new Set([...IDLE_OR_GC, "(program)"]);

export const RUNTIME_ENTRIES = new Set([
  TICKS_NAME,
  "processTimers",
  "processImmediate",
  ...SKIP_WHEN_SEEKING_DONOR,
]);

export function functionName(node: ProfileNode): string {
  return node.callFrame?.functionName || "(anonymous)";
}

export function callFrameKey(frame: CallFrame): string {
  return [
    frame.functionName ?? "",
    frame.scriptId ?? "",
    String(frame.lineNumber ?? ""),
    String(frame.columnNumber ?? ""),
    frame.url ?? "",
  ].join("\0");
}

export type ProfileIndex = {
  profile: CpuProfile;
  /** Parent node id by child id. 0 means no parent. */
  parentOf: Uint32Array;
  /** Node by id. Empty slots are missing ids. */
  nodeAt: Array<ProfileNode | undefined>;
  /** Reused cycle guard for stack walks. A slot holds the walk number that last visited it. */
  seenStamp: Uint32Array;
  walkStamp: number;
  rootId: number;
  /** Interned call-frame id for each node id. Equal frames share one id. */
  frameIdByNode: Map<number, number>;
};

export function buildIndex(profile: CpuProfile): ProfileIndex {
  let maxId = 0;
  for (const node of profile.nodes) {
    if (node.id > maxId) maxId = node.id;
    for (const child of node.children ?? []) if (child > maxId) maxId = child;
  }
  for (const sample of profile.samples) if (sample > maxId) maxId = sample;

  const parentOf = new Uint32Array(maxId + 1);
  const nodeAt: Array<ProfileNode | undefined> = new Array(maxId + 1);
  const seenStamp = new Uint32Array(maxId + 1);
  const idByKey = new Map<string, number>();
  const frameIdByNode = new Map<number, number>();
  let nextFrameId = 1;
  for (const node of profile.nodes) {
    if (node.id > 0 && node.id <= maxId) nodeAt[node.id] = node;
    const raw = callFrameKey(node.callFrame);
    let frameId = idByKey.get(raw);
    if (frameId === undefined) {
      frameId = nextFrameId++;
      idByKey.set(raw, frameId);
    }
    frameIdByNode.set(node.id, frameId);
    for (const child of node.children ?? []) {
      if (child > 0 && child <= maxId) parentOf[child] = node.id;
    }
  }
  const root =
    profile.nodes.find((n) => functionName(n) === ROOT_NAME) ?? profile.nodes[0];
  if (!root) {
    throw new Error("CPU profile has no nodes");
  }
  return {
    profile,
    parentOf,
    nodeAt,
    seenStamp,
    walkStamp: 0,
    rootId: root.id,
    frameIdByNode,
  };
}

export function stackNodes(index: ProfileIndex, leafId: number): ProfileNode[] {
  const { parentOf, nodeAt, seenStamp } = index;
  if (leafId <= 0 || leafId >= parentOf.length) return [];
  let stamp = ++index.walkStamp;
  if (stamp === 0xffffffff) {
    seenStamp.fill(0);
    stamp = index.walkStamp = 1;
  }
  const stack: ProfileNode[] = [];
  let id = leafId;
  while (id !== 0 && id < parentOf.length) {
    if (seenStamp[id] === stamp) break;
    seenStamp[id] = stamp;
    const node = nodeAt[id];
    if (!node) break;
    stack.push(node);
    id = parentOf[id]!;
  }
  return stack;
}

export function cloneCallFrame(frame: CallFrame): CallFrame {
  return {
    functionName: frame.functionName,
    scriptId: frame.scriptId,
    url: frame.url,
    lineNumber: frame.lineNumber,
    columnNumber: frame.columnNumber,
  };
}
