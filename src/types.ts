export type CallFrame = {
  functionName: string;
  scriptId: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
};

export type ProfileNode = {
  id: number;
  callFrame: CallFrame;
  hitCount: number;
  children?: number[];
};

export type CpuProfile = {
  nodes: ProfileNode[];
  startTime: number;
  endTime: number;
  samples: number[];
  timeDeltas: number[];
};

export type UnwrapStats = {
  sampleCount: number;
  maxDepth: number;
  depthThreshold: number;
  candidateCount: number;
  repairedCount: number;
  skippedCount: number;
  cutNames: Record<string, number>;
  rootChildrenBefore: string[];
  rootChildrenAfter: string[];
  samplesWithTicksBefore: number;
  samplesWithTicksAfter: number;
};
