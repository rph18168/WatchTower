export interface WatchTopic {
  id: string;
  description: string;
}

export interface WatchTowerConfig {
  topics: WatchTopic[];
  model: string;
  usage?: Partial<ModelUsageLimits>;
}

export interface ModelUsageLimits {
  monthlyBudgetUsd: number;
  runBudgetUsd: number;
  maxSteps: number;
  maxInputBytes: number;
  maxOutputTokens: number;
}

export type BudgetPauseReason = 'monthly-budget' | 'run-budget' | 'steps' | 'input-size' | 'output-size' | 'unknown-cost' | 'provider-limit' | 'provider-unavailable';

/** Shared by every model operation; production adapters guard every dispatch. */
export interface ModelExecution {
  maxOutputTokens: number;
  beforeRequest(request: { inputBytes: number; maxOutputTokens: number }): Promise<void>;
  recordUsage(usage: ModelCallReceipt): Promise<void>;
}

export interface ModelBudgetState {
  pauseReason: BudgetPauseReason | null;
  calls?: ModelCallRecord[];
  provider?: { checkedAt: string; remainingUsd: number | null; usageMonthlyUsd: number };
}

export interface ModelCallReceipt extends ModelUsage {
  responseId?: string;
  model?: string;
}

export interface ModelCallRecord extends ModelCallReceipt {
  id: string;
  startedAt: string;
  status: 'in-flight' | 'complete' | 'unknown';
}

export interface ModelBudgetStatus {
  month: string;
  monthlyBudgetUsd: number;
  spentUsd: number;
  remainingUsd: number;
  runSpentUsd: number;
  steps: number;
  pauseReason: BudgetPauseReason | null;
}

export interface CandidateStory {
  id: string;
  title: string;
  url?: string;
  hnUrl: string;
  text?: string;
  score: number;
  publishedAt: string;
}

export interface StoredCandidate {
  story: CandidateStory;
  discoveredAt: string;
  status: 'pending' | 'processed';
  processedAt: string | null;
  topicIds: string[];
}

export interface DigestEntry {
  id: string;
  candidateId: string;
  title: string;
  summary: string;
  topicIds: string[];
  sources: { kind: 'original' | 'hn'; url: string }[];
  createdAt: string;
}

export interface MonitoringState {
  schemaVersion: 1;
  candidates: StoredCandidate[];
  digest: DigestEntry[];
  lastRunAt: string | null;
  budget?: ModelBudgetState;
}

/** save resolves only after the state is durable. Failed saves reject. */
export interface StateStore {
  load(): Promise<MonitoringState>;
  save(state: MonitoringState): Promise<void>;
}

export interface HackerNewsAdapter {
  discover(request: { since: string; until: string; minScore: number }): Promise<CandidateStory[]>;
}

/** A numeric aggregate alone does not establish that every call reported cost. */
export interface ModelUsage {
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costComplete?: boolean;
}

export interface CandidateDecision {
  candidateId: string;
  topicIds: string[];
  summary: string | null;
}

export interface DigestModelAdapter {
  /** null means the key has no configured cap, not unlimited funded credit. */
  getAllowance?(): Promise<{ remainingUsd: number | null; usageMonthlyUsd: number }>;
  analyze(request: {
    model: string;
    topics: WatchTopic[];
    candidates: CandidateStory[];
    execution?: ModelExecution;
  }): Promise<{ decisions: CandidateDecision[]; usage: ModelUsage }>;
}

export interface RunCycleOptions {
  loadConfig(): Promise<WatchTowerConfig>;
  state: StateStore;
  hn: HackerNewsAdapter;
  model: DigestModelAdapter;
  clock?: () => Date;
}

export interface CycleResult {
  digest: DigestEntry[];
  markdown: string;
  status: {
    candidateCount: number;
    processedCandidateCount: number;
    pendingCandidateCount: number;
    lastRunAt: string;
    budget: ModelBudgetStatus;
  };
  usage: ModelUsage | null;
}
