import type { ModelCallDiagnostic } from './types.ts';

const stages = new Set(['request', 'transport', 'http', 'response']);
const classes = new Set(['RequestError', 'UnknownError', 'TypeError', 'SyntaxError', 'AbortError', 'TimeoutError', 'HttpError', 'ResponseError', 'ValidationError']);
const transportCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']);

export function nativeErrorClass(error: unknown, fallback: 'UnknownError' | 'RequestError' | 'ResponseError'): ModelCallDiagnostic['errorClass'] {
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'TimeoutError';
  if (error instanceof DOMException && error.name === 'AbortError') return 'AbortError';
  if (error instanceof TypeError) return 'TypeError';
  if (error instanceof SyntaxError) return 'SyntaxError';
  return fallback;
}

/** Only recognized provider ID shapes; arbitrary header/error strings are omitted. */
export function safeRequestId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : undefined;
}

export function safeGenerationId(value: unknown): string | undefined {
  return typeof value === 'string' && /^gen-\d{10,16}-[A-Za-z0-9]{8,128}$/.test(value) ? value : undefined;
}

/** State serialization accepts this projection, never a spread of error metadata. */
export function safeModelDiagnostic(value: unknown): ModelCallDiagnostic | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const data = value as Record<string, unknown>;
  if (typeof data.stage !== 'string' || !stages.has(data.stage) || typeof data.errorClass !== 'string' || !classes.has(data.errorClass)) return undefined;
  const result: ModelCallDiagnostic = { stage: data.stage as ModelCallDiagnostic['stage'], errorClass: data.errorClass as ModelCallDiagnostic['errorClass'] };
  if (typeof data.httpStatus === 'number' && Number.isInteger(data.httpStatus) && data.httpStatus >= 100 && data.httpStatus <= 599) result.httpStatus = data.httpStatus;
  if (typeof data.transportCode === 'string' && transportCodes.has(data.transportCode)) result.transportCode = data.transportCode as ModelCallDiagnostic['transportCode'];
  const requestId = safeRequestId(data.requestId);
  const generationId = safeGenerationId(data.generationId);
  if (requestId) result.requestId = requestId;
  if (generationId) result.generationId = generationId;
  return result;
}
