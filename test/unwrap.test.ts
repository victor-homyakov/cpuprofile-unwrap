import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildIndex, functionName, stackNodes } from "../src/profile.ts";
import type { CallFrame, CpuProfile, ProfileNode } from "../src/types.ts";
import { unwrapProfile } from "../src/unwrap.ts";

function frame(functionName: string, extra = ""): CallFrame {
  return {
    functionName,
    scriptId: extra || "1",
    url: extra ? `file://${extra}.js` : "",
    lineNumber: extra ? extra.length : 0,
    columnNumber: 0,
  };
}

/** Build a profile by merging leaf→root name stacks into a tree. */
function profileFromStacks(stacks: string[][]): CpuProfile {
  const root: ProfileNode = {
    id: 1,
    callFrame: frame("(root)"),
    hitCount: 0,
    children: [],
  };
  const nodes: ProfileNode[] = [root];
  let nextId = 2;
  const childByKey = new Map<string, ProfileNode>();

  function key(parentId: number, name: string): string {
    return `${parentId}\0${name}`;
  }

  const samples: number[] = [];
  for (const stack of stacks) {
    assert.equal(stack[stack.length - 1], "(root)");
    let parent = root;
    for (let i = stack.length - 2; i >= 0; i--) {
      const name = stack[i]!;
      const k = key(parent.id, name);
      let child = childByKey.get(k);
      if (!child) {
        child = {
          id: nextId++,
          callFrame: frame(name, name),
          hitCount: 0,
          children: [],
        };
        nodes.push(child);
        parent.children = parent.children ?? [];
        parent.children.push(child.id);
        childByKey.set(k, child);
      }
      parent = child;
    }
    parent.hitCount++;
    samples.push(parent.id);
  }

  return {
    nodes,
    startTime: 0,
    endTime: stacks.length,
    samples,
    timeDeltas: samples.map(() => 1),
  };
}

function names(profile: CpuProfile, sampleIndex: number): string[] {
  const index = buildIndex(profile);
  return stackNodes(index, profile.samples[sampleIndex]!).map(functionName);
}

const shared = Array.from({ length: 10 }, (_, i) => `shared${i}`);

describe("unwrapProfile", () => {
  it("restores missing outer frames from the neighboring ticks stack", () => {
    const complete = ["leafA", ...shared, "C", "processTicksAndRejections", "(root)"];
    const truncated = ["leafB", ...shared, "(root)"];
    const profile = profileFromStacks([complete, truncated, complete]);

    assert.deepEqual(names(profile, 1), ["leafB", ...shared, "(root)"]);

    const { profile: out, stats } = unwrapProfile(profile);
    assert.equal(stats.repairedCount, 1);
    assert.deepEqual(names(out, 1), [
      "leafB",
      ...shared,
      "C",
      "processTicksAndRejections",
      "(root)",
    ]);
    assert.equal(stats.samplesWithTicksAfter, 3);
    assert.ok(
      out.nodes
        .find((n) => functionName(n) === "(root)")!
        .children!.every((id) => {
          const child = out.nodes.find((n) => n.id === id)!;
          return ["processTicksAndRejections"].includes(functionName(child));
        }),
    );
  });

  it("skips idle and GC when looking for a ticks donor", () => {
    const complete = ["leafA", ...shared, "C", "processTicksAndRejections", "(root)"];
    const truncated = ["leafB", ...shared, "(root)"];
    const idle = ["(idle)", "(root)"];
    const gc = ["(garbage collector)", "(root)"];
    const profile = profileFromStacks([complete, idle, truncated, gc, complete]);

    const { profile: out, stats } = unwrapProfile(profile);
    assert.equal(stats.repairedCount, 1);
    assert.deepEqual(names(out, 2), [
      "leafB",
      ...shared,
      "C",
      "processTicksAndRejections",
      "(root)",
    ]);
  });

  it("does not attach shallow real callbacks to ticks", () => {
    const complete = ["leafA", ...shared, "C", "processTicksAndRejections", "(root)"];
    const short = ["onStreamRead", "(root)"];
    const profile = profileFromStacks([complete, short, complete]);

    const { profile: out, stats } = unwrapProfile(profile);
    assert.equal(stats.repairedCount, 0);
    assert.deepEqual(names(out, 1), ["onStreamRead", "(root)"]);
  });
});
