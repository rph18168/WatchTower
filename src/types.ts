export interface WatchTopic {
  id: string;
  description: string;
}

export interface WatchTowerConfig {
  topics: WatchTopic[];
  model: string;
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
  analyze(request: {
    model: string;
    topics: WatchTopic[];
    candidates: CandidateStory[];
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
  };
  usage: ModelUsage | null;
}
