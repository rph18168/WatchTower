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

export type TelegramCommand = 'digest' | 'status' | 'pause' | 'resume';

/** Identity and raw message content have already been checked inside the adapter. */
export interface TelegramControlUpdate {
  updateId: number;
  command: TelegramCommand | null;
}

export interface TelegramControlAdapter extends TelegramSendAdapter {
  getUpdates(request: { offset: number }): Promise<TelegramControlUpdate[]>;
}

/** Shared durable outbox fields; recipient identity never enters the queue. */
export interface NotificationDelivery {
  id: string;
  text: string;
  createdAt: string;
  status: 'pending' | 'sent';
  sentAt: string | null;
  messageId?: string;
  attempts: ({ at: string } & TelegramSendResult)[];
}

export interface DevelopmentNotification extends NotificationDelivery {
  /** Missing kind/origin denotes a development in snapshots from older runs. */
  kind?: 'development';
  origin?: 'proactive';
  candidateId: string;
  topicIds: string[];
  change: string;
  whyItMatters: string;
  claims: DevelopmentVerification['claims'];
  sources: { kind: 'original' | 'hn'; url: string }[];
  /** Persisted batches own delivery once this development joins a summary. */
  summaryIds?: string[];
}

export interface CommandReplyNotification extends NotificationDelivery {
  kind: 'command-reply';
  origin: 'command-reply';
}

export interface BudgetStatusNotification extends NotificationDelivery {
  kind: 'budget-status';
  origin: 'proactive';
}

export interface OvernightSummaryNotification extends NotificationDelivery {
  kind: 'overnight-summary';
  origin: 'proactive';
  notificationIds: string[];
}

export type PendingNotification = DevelopmentNotification | CommandReplyNotification | BudgetStatusNotification | OvernightSummaryNotification;

export interface DigestEntry {
  id: string;
  candidateId: string;
  title: string;
  summary: string;
  topicIds: string[];
  sources: { kind: 'original' | 'hn'; url: string }[];
  createdAt: string;
}

export interface MonitoringFault {
  code: 'telegram-updates' | 'candidate-discovery' | 'model-processing' | 'source-reading';
  at: string;
}

export interface MonitoringState {
  schemaVersion: 1;
  candidates: StoredCandidate[];
  digest: DigestEntry[];
  notifications: PendingNotification[];
  lastRunAt: string | null;
  budget?: ModelBudgetState;
  control?: {
    manuallyPaused: boolean;
    telegramOffset?: number;
    lastHandledUpdateId?: number;
    /** Explicit resume grants one new generation of delivery recovery attempts. */
    deliveryRetryGeneration?: number;
    fault?: MonitoringFault;
    budgetNotice?: { fingerprint: string | null; sequence: number };
  };
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

export interface DigestModelAdapter {
  /** null means the key has no configured cap, not unlimited funded credit. */
  getAllowance?(): Promise<{ remainingUsd: number | null; usageMonthlyUsd: number }>;
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
}

export interface RunCycleOptions {
  /** Process and deliver authorized control replies without autonomous work. */
  commandsOnly?: boolean;
  loadConfig(): Promise<WatchTowerConfig>;
  state: StateStore;
  hn: HackerNewsAdapter;
  model: DigestModelAdapter;
  sources?: SourceReaderAdapter;
  telegram?: TelegramSendAdapter & Partial<Pick<TelegramControlAdapter, 'getUpdates'>>;
  clock?: () => Date;
}

export interface CycleResult {
  digest: DigestEntry[];
  markdown: string;
  notifications: PendingNotification[];
  status: {
    manuallyPaused: boolean;
    fault: MonitoringFault | null;
    candidateCount: number;
    processedCandidateCount: number;
    pendingCandidateCount: number;
    lastRunAt: string;
    budget: ModelBudgetStatus;
  };
  usage: ModelUsage | null;
}
