import type { ProcessEnv } from "node:process";

export interface GateStack {
  unit: string;
  shardId: string;
  sliceHash: string;
  runId?: string;
  runDir?: string;
  storePath?: string;
  shardPath?: string;
  sharedProof?: string;
  stop(): Promise<{ ok: true } | { ok: false }>;
}

export interface RuntimeJourneyContext {
  port: number;
  stack: GateStack;
  passDir: string;
  actorId(suffix: string): string;
  session(options: { actorId?: string }): unknown;
  grant(actorId: string, name: string, quantity?: number): Promise<unknown>;
  grantSkills(actorId: string, skillBoxIds: string[]): Promise<unknown>;
  check(description: string, condition: unknown): void;
  note(description: string): void;
  skip(reason: string): never;
}

export interface JourneyDefinition<TContext = RuntimeJourneyContext> {
  id: string;
  run(context: TContext): Promise<void>;
  skip?: string | null;
}

export interface JourneyResult {
  [key: string]: unknown;
  id: string;
  status: "pass" | "fail" | "skip";
  durationMs?: number;
  checks?: Array<{ desc: string; ok: boolean }>;
  error?: string;
  reason?: string;
  transcriptPath?: string;
  artifactDir?: string;
}

export interface JourneyPass {
  pass: number;
  results: JourneyResult[];
  mode?: "shared" | "isolated";
  port?: number;
  shardId?: string;
  sliceHash?: string;
  concurrency?: number;
}

export interface JourneyGateManifest {
  schema: "successor.tui-gate.v1";
  runId: string;
  startedAt: string;
  bar: string;
  status: "pass" | "fail";
  mode?: "isolated";
  concurrency?: number;
  passes: [JourneyPass, ...JourneyPass[]];
}

export interface RunJourneyGateOptions<TContext = RuntimeJourneyContext> {
  argv?: string[];
  env?: ProcessEnv;
  repoRoot?: string;
  clientTuiRoot?: string;
  journeyDir?: string;
  cliPath?: string;
  sourceDirs?: string[];
  artifactRoot?: string;
  now?: () => number;
  log?: (...args: never[]) => void;
  errorLog?: (...args: never[]) => void;
  preflight?: boolean;
  journeys?: JourneyDefinition<TContext>[];
  startStackFn?: (...args: never[]) => Promise<GateStack>;
  resetStackFn?: (port: number) => Promise<unknown>;
  prepareStackBuildFn?: (...args: never[]) => unknown;
  createSessionFn?: (...args: never[]) => unknown;
  grantFn?: (...args: never[]) => unknown;
  grantSkillsFn?: (...args: never[]) => unknown;
}

export interface JourneyGateResult {
  exitCode: 0 | 1 | 2;
  manifest: JourneyGateManifest | null;
  manifestPath: string | null;
}

export interface JourneyGateWithJourneysResult {
  exitCode: 0 | 1;
  manifest: JourneyGateManifest;
  manifestPath: string;
}

export interface EnsureBuiltCliOptions {
  cliPath?: string;
  sourceDirs?: string[];
  repoRoot?: string;
  env?: ProcessEnv;
}

export function ensureBuiltCli(options?: EnsureBuiltCliOptions): void;
export function runJourneyGate<TContext>(options: RunJourneyGateOptions<TContext> & { journeys: JourneyDefinition<TContext>[] }): Promise<JourneyGateWithJourneysResult>;
export function runJourneyGate<TContext = RuntimeJourneyContext>(options?: RunJourneyGateOptions<TContext>): Promise<JourneyGateResult>;

export function parseRunnerArgs(argv: string[], env?: ProcessEnv): {
  isolated: boolean;
  once: boolean;
  only: string[] | null;
  concurrency: number;
  portBase: number;
  skipBuild: boolean;
};
export function mapBounded<T, R>(items: T[], concurrency: number, worker: (item: T, index: number, slot: number) => Promise<R>): Promise<R[]>;
export function loadJourneys(options?: { journeyDir?: string; only?: string[] | null }): Promise<JourneyDefinition[]>;
export function isolatedJourneyLayout(options: {
  env?: ProcessEnv;
  repoRoot?: string;
  artifactRoot: string;
  gateRunId: string;
  journeyId: string;
  index: number;
  total: number;
  portBase: number;
}): {
  port: number;
  runId: string;
  runDir: string;
  storePath: string;
  shardPath: string;
  artifactDir: string;
  unit: string;
};
export function materializeActorId(gateRunId: string, passIndex: number, journeyId: string, suffix: string): string;
