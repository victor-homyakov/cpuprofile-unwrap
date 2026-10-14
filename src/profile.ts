import type { CallFrame, CpuProfile, ProfileNode } from "./types.ts";

export const RUNTIME_ENTRIES = new Set([
  "processTicksAndRejections",
  "processTimers",
  "processImmediate",
  "(idle)",
  "(program)",
  "(garbage collector)",
]);

export const IDLE_OR_GC = new Set(["(idle)", "(garbage collector)"]);

export const SKIP_WHEN_SEEKING_DONOR = new Set([
  "(idle)",
  "(garbage collector)",
  "(program)",
]);

export const TICKS_NAME = "processTicksAndRejections";
export const ROOT_NAME = "(root)";

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

export function nodeKey(node: ProfileNode): string {
  return callFrameKey(node.callFrame);
}

export type ProfileIndex = {
  profile: CpuProfile;
  nodesById: Map<number, ProfileNode>;
  parent: Map<number, number>;
  rootId: number;
  /** Interned call-frame key for each node id. Equal frames share one string. */
  frameKeyByNode: Map<number, string>;
};

export function buildIndex(profile: CpuProfile): ProfileIndex {
  const nodesById = new Map<number, ProfileNode>();
  const parent = new Map<number, number>();
  const canonicalKey = new Map<string, string>();
  const frameKeyByNode = new Map<number, string>();
  for (const node of profile.nodes) {
    nodesById.set(node.id, node);
    const raw = callFrameKey(node.callFrame);
    let key = canonicalKey.get(raw);
    if (key === undefined) {
      key = raw;
      canonicalKey.set(raw, key);
    }
    frameKeyByNode.set(node.id, key);
    for (const child of node.children ?? []) {
      parent.set(child, node.id);
    }
  }
  const root =
    profile.nodes.find((n) => functionName(n) === ROOT_NAME) ?? profile.nodes[0];
  if (!root) {
    throw new Error("CPU profile has no nodes");
  }
  return { profile, nodesById, parent, rootId: root.id, frameKeyByNode };
}

/** Stack of node ids from leaf to root. */
export function stackIds(index: ProfileIndex, leafId: number): number[] {
  const stack: number[] = [];
  const seen = new Set<number>();
  let id: number | undefined = leafId;
  while (id !== undefined && !seen.has(id)) {
    seen.add(id);
    const node = index.nodesById.get(id);
    if (!node) break;
    stack.push(id);
    id = index.parent.get(id);
  }
  return stack;
}

export function stackNodes(index: ProfileIndex, leafId: number): ProfileNode[] {
  return stackIds(index, leafId).map((id) => index.nodesById.get(id)!);
}

export function nearRootName(nodes: ProfileNode[]): string {
  if (nodes.length >= 2) return functionName(nodes[nodes.length - 2]!);
  return nodes.length ? functionName(nodes[0]!) : "";
}

export function hasTicks(nodes: ProfileNode[]): boolean {
  return nodes.some((n) => functionName(n) === TICKS_NAME);
}

export function isIdleOrGcStack(nodes: ProfileNode[]): boolean {
  return nodes.some((n) => IDLE_OR_GC.has(functionName(n)));
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
