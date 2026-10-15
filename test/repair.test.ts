import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pruneUnreachable } from "../src/repair.ts";
import type { CallFrame, CpuProfile, ProfileNode } from "../src/types.ts";

function frame(functionName: string): CallFrame {
  return { functionName, scriptId: "1", url: "", lineNumber: 0, columnNumber: 0 };
}

function node(id: number, name: string, children?: number[]): ProfileNode {
  return { id, callFrame: frame(name), hitCount: 0, children };
}

function profile(nodes: ProfileNode[], samples: number[]): CpuProfile {
  return {
    nodes,
    startTime: 0,
    endTime: samples.length,
    samples,
    timeDeltas: samples.map(() => 1),
  };
}

function ids(nodes: ProfileNode[]): number[] {
  return nodes.map((n) => n.id).sort((a, b) => a - b);
}

describe("pruneUnreachable", () => {
  it("drops nodes no sample reaches and keeps the shared ancestor", () => {
    const tree = profile(
      [
        node(1, "(root)", [2, 4]),
        node(2, "A", [3, 5]),
        node(3, "B"),
        node(5, "C"),
        node(4, "D"),
      ],
      [3],
    );

    pruneUnreachable(tree, 1);

    assert.deepEqual(ids(tree.nodes), [1, 2, 3]);
    assert.deepEqual(tree.nodes.find((n) => n.id === 2)!.children, [3]);
    assert.deepEqual(tree.nodes.find((n) => n.id === 1)!.children, [2]);
  });

  it("keeps one shared ancestor for two samples", () => {
    const tree = profile(
      [
        node(1, "(root)", [2]),
        node(2, "A", [3, 4]),
        node(3, "B"),
        node(4, "C"),
        node(9, "orphan"),
      ],
      [3, 4],
    );

    pruneUnreachable(tree, 1);

    assert.deepEqual(ids(tree.nodes), [1, 2, 3, 4]);
    assert.deepEqual(tree.nodes.find((n) => n.id === 2)!.children, [3, 4]);
  });

  it("stops on a parent cycle", () => {
    const tree = profile(
      [node(1, "(root)", [2]), node(2, "A", [3]), node(3, "B", [2])],
      [3],
    );

    pruneUnreachable(tree, 1);

    assert.deepEqual(ids(tree.nodes), [1, 2, 3]);
  });
});
