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
  notificationReview?: {
    proposal: SignificanceProposal;
    status: 'pending' | 'complete';
    source?: SourceEvidence;
  };
}

export interface SignificanceProposal {
  change: string;
  whyItMatters: string;
}

/** Untrusted text from only this candidate's approved linked page. */
export interface SourceEvidence {
  id: string;
  candidateId: string;
  originalUrl: string;
  finalUrl?: string;
  status: 'read' | 'unavailable';
  title: string;
  text: string;
  truncated: boolean;
  failureCode?: 'unsafe-url' | 'network' | 'timeout' | 'redirect' | 'unsupported-content' | 'too-large' | 'empty';
}

export interface SourceReaderAdapter {
  read(request: { candidateId: string; url: string }): Promise<SourceEvidence>;
}

export interface DevelopmentVerification extends SignificanceProposal {
  supported: boolean;
  uncertainty: string | null;
  sourceRole: 'primary' | 'secondary' | 'unknown';
  claims: { statement: string; sourceId: string; quote: string }[];
}

export type TelegramSendResult =
  | { status: 'sent'; messageId: string }
  | { status: 'failed' | 'unknown'; failureCode: 'rate-limited' | 'recipient-unavailable' | 'rejected' | 'network' | 'invalid-response'; retryAfterSeconds?: number; permanent?: boolean };

/** Recipient identity is held by the adapter, never in public application state. */
export interface TelegramSendAdapter {
  send(request: { text: string }): Promise<TelegramSendResult>;
}

export interface PendingNotification {
  id: string;
  candidateId: string;
  topicIds: string[];
  text: string;
  change: string;
  whyItMatters: string;
  claims: DevelopmentVerification['claims'];
  sources: { kind: 'original' | 'hn'; url: string }[];
  createdAt: string;
  status: 'pending' | 'sent';
  sentAt: string | null;
  messageId?: string;
  attempts: ({ at: string } & TelegramSendResult)[];
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
  notifications: PendingNotification[];
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
  significance?: SignificanceProposal | null;
}

export interface ModelExecution {
  maxOutputTokens: number;
  beforeRequest(request: { inputBytes: number; maxOutputTokens: number }): Promise<void>;
  recordUsage(usage: ModelUsage): Promise<void>;
}

export interface DigestModelAdapter {
  analyze(request: {
    model: string;
    topics: WatchTopic[];
    candidates: CandidateStory[];
    execution?: ModelExecution;
  }): Promise<{ decisions: CandidateDecision[]; usage: ModelUsage }>;
  verifyDevelopment?(request: {
    model: string;
    topics: WatchTopic[];
    candidate: CandidateStory;
    proposal: SignificanceProposal;
    source: SourceEvidence;
    execution?: ModelExecution;
  }): Promise<{ verification: DevelopmentVerification; usage: ModelUsage }>;
  getAllowance?(): Promise<{ remainingUsd: number | null; usageMonthlyUsd: number }>;
}

export interface RunCycleOptions {
  loadConfig(): Promise<WatchTowerConfig>;
  state: StateStore;
  hn: HackerNewsAdapter;
  model: DigestModelAdapter;
  sources?: SourceReaderAdapter;
  telegram?: TelegramSendAdapter;
  clock?: () => Date;
}

export interface CycleResult {
  digest: DigestEntry[];
  markdown: string;
  notifications: PendingNotification[];
  status: {
    candidateCount: number;
    processedCandidateCount: number;
    pendingCandidateCount: number;
    lastRunAt: string;
  };
  usage: ModelUsage | null;
}
