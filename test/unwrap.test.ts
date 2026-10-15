import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildIndex, callFrameKey, functionName, stackNodes } from "../src/profile.ts";
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

/** Same as profileFromStacks, but frames are supplied explicitly. */
function profileFromFrameStacks(stacks: CallFrame[][]): CpuProfile {
  const root: ProfileNode = {
    id: 1,
    callFrame: frame("(root)"),
    hitCount: 0,
    children: [],
  };
  const nodes: ProfileNode[] = [root];
  let nextId = 2;
  const childByKey = new Map<string, ProfileNode>();
  const samples: number[] = [];

  for (const stack of stacks) {
    assert.equal(stack[stack.length - 1]!.functionName, "(root)");
    let parent = root;
    for (let i = stack.length - 2; i >= 0; i--) {
      const callFrame = stack[i]!;
      const k = `${parent.id}\0${callFrameKey(callFrame)}`;
      let child = childByKey.get(k);
      if (!child) {
        child = {
          id: nextId++,
          callFrame,
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

function at(functionName: string, url: string, lineNumber: number): CallFrame {
  return { functionName, scriptId: url, url, lineNumber, columnNumber: 0 };
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

  it("does not treat same function names at different locations as one frame", () => {
    const sharedA = shared.map((name, i) => at(name, "a.js", i));
    const sharedB = shared.map((name, i) => at(name, "b.js", i));
    const root = at("(root)", "", 0);
    const profile = profileFromFrameStacks([
      [at("leafA", "a.js", 1), ...sharedA, at("C", "a.js", 20), at("processTicksAndRejections", "node:internal", 1), root],
      [at("leafB", "b.js", 1), ...sharedB, root],
      [at("leafA", "a.js", 1), ...sharedA, at("C", "a.js", 20), at("processTicksAndRejections", "node:internal", 1), root],
    ]);

    const { stats } = unwrapProfile(profile);
    assert.equal(stats.repairedCount, 0);
    assert.deepEqual(names(profile, 1), ["leafB", ...shared, "(root)"]);
  });

  it("reuses one restored path for samples that need the same outer frames", () => {
    const complete = ["leafA", ...shared, "C", "processTicksAndRejections", "(root)"];
    const truncated = ["leafB", ...shared, "(root)"];
    const profile = profileFromStacks([complete, truncated, truncated]);

    const { profile: out, stats } = unwrapProfile(profile);
    assert.equal(stats.repairedCount, 2);
    const index = buildIndex(out);
    const first = stackNodes(index, out.samples[1]!);
    const second = stackNodes(index, out.samples[2]!);
    const idOf = (stack: ProfileNode[], name: string) =>
      stack.find((n) => functionName(n) === name)!.id;
    assert.equal(idOf(first, "C"), idOf(second, "C"));
    assert.equal(
      idOf(first, "processTicksAndRejections"),
      idOf(second, "processTicksAndRejections"),
    );
    assert.equal(out.samples[1], out.samples[2]);
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

describe("stackNodes", () => {
  it("stops on a parent cycle", () => {
    const cyc = profileFromStacks([["leaf", "(root)"]]);
    const leaf = cyc.nodes.find((n) => functionName(n) === "leaf")!;
    const root = cyc.nodes.find((n) => functionName(n) === "(root)")!;
    leaf.children = [root.id];
    root.children = [leaf.id];
    const index = buildIndex(cyc);
    const namesOnCycle = stackNodes(index, leaf.id).map(functionName);
    assert.deepEqual(namesOnCycle, ["leaf", "(root)"]);
  });
});
