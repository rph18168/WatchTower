import { createHash } from 'node:crypto';
import type { CandidateStory, DevelopmentVerification, MonitoringState, SourceEvidence, StoredCandidate, VerifiedEvidenceCheckpoint } from './types.ts';
import { safeModelDiagnostic } from './model-diagnostics.ts';

const hashPattern = /^sha256:v1:[0-9a-f]{64}$/;

function hash(value: string): string {
  return `sha256:v1:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

/** Score and discovery timestamps cannot turn the same material into new work. */
export function candidateFingerprint(story: CandidateStory): string {
  let url = story.url ?? null;
  try { if (url) url = new URL(url).href; } catch { /* Preserve malformed legacy identity. */ }
  return hash(JSON.stringify([1, story.title, url, story.text ?? null]));
}

export function evidenceHash(claim: DevelopmentVerification['claims'][number]): string {
  return claim.evidenceHash ?? hash(JSON.stringify([1, claim.statement, claim.quote]));
}

/** A small retention guard, not a substitute for the model's factual judgment. */
export function conciseParaphrase(text: unknown, originals: string[]): text is string {
  if (typeof text !== 'string' || !text.trim() || text.length > 700) return false;
  const normalized = text.replace(/\s+/gu, ' ').trim();
  for (const original of originals) {
    const source = original.replace(/\s+/gu, ' ').trim();
    for (let offset = 0; offset + 80 <= normalized.length; offset++) {
      if (source.includes(normalized.slice(offset, offset + 80))) return false;
    }
  }
  return true;
}

function compactClaims(claims: DevelopmentVerification['claims']): DevelopmentVerification['claims'] {
  return claims.slice(0, 12).map((claim) => ({
    statement: conciseParaphrase(claim.statement, [claim.quote]) ? claim.statement : '旧证据摘要超出公开保存边界。', sourceId: claim.sourceId,
    quote: '', evidenceHash: evidenceHash(claim),
  }));
}

function sourceMetadata(source: SourceEvidence): SourceEvidence {
  return {
    id: source.id, candidateId: source.candidateId, originalUrl: source.originalUrl,
    ...(source.finalUrl ? { finalUrl: source.finalUrl } : {}),
    status: source.status, title: source.title.slice(0, 256), text: '', truncated: source.truncated,
    ...(source.text ? { contentHash: hash(source.text) } : source.contentHash ? { contentHash: source.contentHash } : {}),
    ...(source.failureCode ? { failureCode: source.failureCode } : {}),
  };
}

function verificationShape(verification: DevelopmentVerification): boolean {
  return verification?.supported === true && verification.uncertainty === null &&
    ['primary', 'secondary'].includes(verification.sourceRole) &&
    [verification.change, verification.whyItMatters].every((text) => typeof text === 'string' && text.length <= 700 && /\p{Script=Han}/u.test(text)) &&
    Array.isArray(verification.claims) && verification.claims.length > 0 && verification.claims.length <= 12 &&
    verification.claims.some(({ statement }) => statement === verification.change) &&
    verification.claims.every(({ statement }) => typeof statement === 'string' && Boolean(statement.trim()) && statement.length <= 700);
}

function sourceIdentity(source: SourceEvidence, candidate: StoredCandidate): boolean {
  return source.status === 'read' && !source.truncated && source.id === `source:${candidate.story.id}` &&
    source.candidateId === candidate.story.id && Boolean(candidate.story.url) && source.originalUrl === candidate.story.url;
}

/** A paid result is reusable without retaining the source or verbatim evidence. */
export function retainedEvidence(candidate: StoredCandidate, at: string): { verification: DevelopmentVerification; source: SourceEvidence } | undefined {
  const review = candidate.notificationReview;
  if (!review) return undefined;
  const fingerprint = candidate.contentFingerprint ?? candidateFingerprint(candidate.story);
  const checkpoint = review.checkpoint;
  if (checkpoint?.validationVersion === 1 && Number.isFinite(Date.parse(checkpoint.verifiedAt)) &&
    checkpoint.candidateFingerprint === fingerprint && sourceIdentity(checkpoint.source, candidate) &&
    hashPattern.test(checkpoint.source.contentHash ?? '') && verificationShape(checkpoint.verification) &&
    checkpoint.verification.claims.every(({ sourceId, evidenceHash }) => sourceId === checkpoint.source.id && hashPattern.test(evidenceHash ?? ''))) {
    // Preserve transient full claims in the current runner, if still available.
    if (review.source?.text && review.verification) return { source: review.source, verification: review.verification };
    return { source: checkpoint.source, verification: checkpoint.verification };
  }
  const source = review.source;
  const verification = review.verification;
  if (!source || !verification || !sourceIdentity(source, candidate) || !source.text.trim() || !verificationShape(verification) ||
    ![verification.change, verification.whyItMatters, ...verification.claims.map(({ statement }) => statement)].every((text) => conciseParaphrase(text, [source.text])) ||
    !verification.claims.every(({ sourceId, quote }) => sourceId === source.id && typeof quote === 'string' && quote.trim().length >= 12 && source.text.includes(quote))) return undefined;
  const retained: VerifiedEvidenceCheckpoint = {
    validationVersion: 1, verifiedAt: at, candidateFingerprint: fingerprint, source: sourceMetadata(source),
    verification: { supported: true, change: verification.change, whyItMatters: verification.whyItMatters,
      uncertainty: null, sourceRole: verification.sourceRole, claims: compactClaims(verification.claims) },
  };
  review.checkpoint = retained;
  return { source, verification };
}

/** This is a copy: actual model input and its byte accounting stay unchanged. */
export function publicStatePayload(state: MonitoringState): MonitoringState {
  const snapshot = structuredClone(state);
  for (const call of snapshot.budget?.calls ?? []) {
    const diagnostic = safeModelDiagnostic(call.diagnostic);
    if (diagnostic) call.diagnostic = diagnostic;
    else delete call.diagnostic;
  }
  for (const candidate of snapshot.candidates) {
    candidate.contentFingerprint ??= candidateFingerprint(candidate.story);
    candidate.hasStoryText = Boolean(candidate.story.text) || candidate.hasStoryText === true;
    const retained = retainedEvidence(candidate, candidate.processedAt ?? state.lastRunAt ?? '1970-01-01T00:00:00.000Z');
    delete candidate.story.text;
    const review = candidate.notificationReview;
    if (review?.source) review.source = sourceMetadata(review.source);
    if (review && !retained) delete review.checkpoint;
    if (review?.checkpoint) {
      const checkpoint = review.checkpoint;
      const verification = checkpoint.verification;
      review.checkpoint = {
        validationVersion: 1, verifiedAt: checkpoint.verifiedAt, candidateFingerprint: checkpoint.candidateFingerprint,
        source: sourceMetadata(checkpoint.source), verification: { supported: true, change: verification.change,
          whyItMatters: verification.whyItMatters, uncertainty: null, sourceRole: verification.sourceRole, claims: compactClaims(verification.claims) },
      };
    }
    // Unvalidated model responses are never an operational recovery record.
    if (review) delete review.verification;
  }
  for (const development of snapshot.developments ?? []) {
    for (const revision of development.revisions) revision.claims = compactClaims(revision.claims);
  }
  for (const notification of snapshot.notifications) {
    if (notification.kind === undefined || notification.kind === 'development') notification.claims = compactClaims(notification.claims);
  }
  return snapshot;
}
