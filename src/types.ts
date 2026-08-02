export type OutputKind = "markdown" | "file-exists" | "verdict" | "json" | "yaml";

export interface ContractOutput {
  path: string;
  kind: OutputKind;
  required: boolean;
}

export type WorkerType = "research" | "code-run" | "reviewer" | "write" | "read-only";

export type GateKind = "reviewer" | "none";
export type Verdict = "lgtm" | "iterate" | "escalate";

export type ThinkingLevelName = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const THINKING_LEVELS: readonly ThinkingLevelName[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface LoopConfig {
  gate: GateKind;
  max_iterations: number;
  lgtm_count: number;
}

export interface WorkerSpec {
  id: string;
  type: WorkerType;
  task: string;
  model?: string;
  effort?: ThinkingLevelName;
  depends_on: string[];
  outputs: ContractOutput[];
  iterate?: boolean;
  worktree?: boolean;
}

export interface FleetConfig {
  max_concurrent: number;
  model?: string;
  effort?: ThinkingLevelName;
  warn_cost_usd?: number;
  loop?: LoopConfig;
}

export interface FleetSpec {
  fleet_name: string;
  type: "dag";
  config: FleetConfig;
  workers: WorkerSpec[];
}

export type NodeStatus =
  | "pending" | "ready" | "running"
  | "completed" | "failed" | "contract_failed" | "killed" | "blocked";

export const TERMINAL_NODE_STATUSES: ReadonlySet<NodeStatus> = new Set([
  "completed", "failed", "contract_failed", "killed", "blocked",
]);

export type FleetStatus = "planned" | "running" | "paused" | "completed" | "failed" | "killed";

export interface ContractCheck {
  path: string;
  kind: OutputKind;
  required: boolean;
  ok: boolean;
  error?: string;
}

export interface ContractResult {
  ok: boolean;
  checks: ContractCheck[];
  verdict?: Verdict;
  verdict_body?: string;
}

export interface NodeState {
  status: NodeStatus;
  started_at?: string;
  ended_at?: string;
  turns: number;
  tokens: number;
  cost_usd_estimate: number;
  contract_result?: ContractResult;
  produced_outputs: string[];
  status_note?: string;
}

export interface IterationSnapshot {
  n: number;
  verdict: Verdict | null;
  verdict_body: string | null;
  started_at: string;
  ended_at: string;
  nodes: Record<string, NodeState>;
}

export interface FleetState {
  fleet_name: string;
  status: FleetStatus;
  created_at: string;
  cost_usd_estimate: number;
  nodes: Record<string, NodeState>;
  iteration: number;
  lgtm_streak: number;
  paused: boolean;
  iterations: IterationSnapshot[];
}

export const WORKER_TYPE_TOOLS: Record<WorkerType, string[]> = {
  "research": ["read", "grep", "find", "ls", "write", "web_search", "fetch_content"],
  "code-run": ["read", "bash", "edit", "write", "grep", "find", "ls"],
  "reviewer": ["read", "write", "grep", "find", "ls"],
  "write": ["read", "write", "grep", "find", "ls"],
  "read-only": ["read", "grep", "find", "ls"],
};
