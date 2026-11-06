import { OpenRouter } from '@openrouter/agent';
import type { PostModelCallPayload } from '@openrouter/agent';
import { HTTPClient } from '@openrouter/sdk/lib/http';
import type { ModelCallDiagnostic, ModelExecution, ModelUsage } from '../types.ts';
import { nativeErrorClass, safeGenerationId, safeModelDiagnostic, safeRequestId } from '../model-diagnostics.ts';

export interface StructuredModelResult {
  data: unknown;
  usage: ModelUsage;
  response: Pick<ModelCallDiagnostic, 'httpStatus' | 'requestId' | 'generationId'>;
}

/** Allowlisted accounting only. SDK/transport errors must not escape to logs. */
export class StructuredModelError extends Error {
  readonly usage: ModelUsage;
  readonly code?: 'provider-limit';
  readonly diagnostic?: ModelCallDiagnostic;
  constructor(usage: ModelUsage, code?: 'provider-limit', diagnostic?: ModelCallDiagnostic) {
    super('OpenRouter structured request failed; accounting retained');
    this.name = 'StructuredModelError';
    this.usage = usage;
    this.code = code;
    this.diagnostic = diagnostic;
  }
}

/** Same wire envelope as the SDK, with a small allowance for SDK metadata. */
export function structuredRequestBytes(request: { model: string; instructions: string; input: string; schema: Record<string, unknown>; name: string }, maxOutputTokens: number): number {
  return Buffer.byteLength(JSON.stringify({
    model: request.model, instructions: request.instructions, input: request.input,
    text: { format: { type: 'json_schema', name: request.name, strict: true, schema: request.schema } },
    provider: { require_parameters: true }, max_output_tokens: maxOutputTokens, stream: true, store: false,
  }), 'utf8') + 128;
}

export function createStructuredExecutor(options: { apiKey: string; fetch?: typeof fetch }) {
  if (!options.apiKey.trim()) throw new Error('OPENROUTER_API_KEY is required');
  return async (request: {
    model: string; instructions: string; input: string;
    schema: Record<string, unknown>; name: string; execution?: ModelExecution;
    reasoning?: { effort: 'low' };
  }): Promise<StructuredModelResult> => {
    const calls: PostModelCallPayload[] = [];
    let dispatches = 0;
    let admissionError: unknown;
    let receiptFailed = false;
    let rejectedRequests = 0;
    let diagnostic: ModelCallDiagnostic | undefined;
    let responseMetadata: Pick<ModelCallDiagnostic, 'httpStatus' | 'requestId' | 'generationId'> = {};
    const client = new OpenRouter({
      apiKey: options.apiKey,
      httpClient: new HTTPClient({ fetcher: async (input, init) => {
        let response: Response;
        try { response = await (options.fetch ?? fetch)(input, init); }
        catch (error) {
          const cause = error instanceof Error ? error.cause : undefined;
          diagnostic = safeModelDiagnostic({ stage: 'transport', errorClass: nativeErrorClass(error, 'UnknownError'),
            transportCode: cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined });
          throw error;
        }
        responseMetadata = { httpStatus: response.status, requestId: safeRequestId(response.headers.get('x-request-id')) };
        if (!response.ok) diagnostic = { stage: 'http', errorClass: 'HttpError', ...responseMetadata };
        if (response.status === 402 || response.status === 429) {
          rejectedRequests += 1;
          try {
            // Explicit provider refusal has no completed generation. Other
            // failed/ambiguous transports retain unknown accounting instead.
            await request.execution?.recordUsage({ costUsd: 0, inputTokens: 0, outputTokens: 0, costComplete: true, diagnostic });
          } catch { receiptFailed = true; }
        }
        return response;
      } }),
      retryConfig: { strategy: 'none' }, timeoutMs: 60_000,
      hooks: { beforeRequest: async (_context, outbound) => {
        try {
          if (receiptFailed) throw new Error('Model accounting was not persisted');
          const body = await outbound.clone().text();
          await request.execution?.beforeRequest({ inputBytes: Buffer.byteLength(body, 'utf8'), maxOutputTokens: JSON.parse(body).max_output_tokens });
          dispatches += 1;
          return outbound;
        } catch (error) {
          admissionError = error;
          throw error;
        }
      } },
    });
    const result = client.callModel({
      model: request.model, instructions: request.instructions, input: request.input,
      tools: [],
      text: { format: { type: 'json_schema', name: request.name, strict: true, schema: request.schema } },
      provider: { requireParameters: true },
      reasoning: request.reasoning,
      maxOutputTokens: request.execution?.maxOutputTokens ?? 4096,
      allowFinalResponse: false, signal: AbortSignal.timeout(60_000), store: false,
      hooks: { PostModelCall: [{ handler: async (event) => {
        calls.push(event);
        const cost = event.usage?.cost;
        try {
          await request.execution?.recordUsage({
            responseId: event.responseId, model: event.model,
            costUsd: amount(cost) ? cost : null,
            inputTokens: event.usage?.inputTokens ?? null,
            outputTokens: event.usage?.outputTokens ?? null,
            costComplete: amount(cost),
          });
        } catch {
          // Hook errors may be logged by the SDK. Keep the failure local and
          // stop before another dispatch or delivery of an application result.
          receiptFailed = true;
        }
      } }] },
    }, { timeoutMs: 60_000, retries: { strategy: 'none' } });
    let materialized = false;
    let decoded = false;
    let data: unknown;
    try {
      const response = await result.getResponse();
      materialized = true;
      responseMetadata.generationId = safeGenerationId(response.id);
      if (response.status !== 'completed') throw new Error('Incomplete model response');
      data = JSON.parse(await result.getText());
      decoded = true;
    } catch (error) {
      diagnostic ??= { ...responseMetadata, stage: responseMetadata.httpStatus === undefined ? 'request' : 'response',
        errorClass: nativeErrorClass(error, responseMetadata.httpStatus === undefined ? 'RequestError' : 'ResponseError') };
      // Failed getUsage() logs the original SDK error. Use the per-call
      // receipts when no response materialized, retaining uncertainty.
    }
    const totals = materialized ? await result.getUsage() : {
      modelCalls: calls.length,
      inputTokens: calls.reduce((sum, call) => sum + (call.usage?.inputTokens ?? 0), 0),
      outputTokens: calls.reduce((sum, call) => sum + (call.usage?.outputTokens ?? 0), 0),
      cost: calls.some(({ usage }) => amount(usage?.cost))
        ? calls.reduce((sum, call) => sum + (amount(call.usage?.cost) ? call.usage!.cost! : 0), 0)
        : undefined,
    };
    const usage: ModelUsage = {
      costUsd: amount(totals.cost) ? totals.cost : rejectedRequests ? 0 : null,
      inputTokens: calls.length || rejectedRequests ? totals.inputTokens : null,
      outputTokens: calls.length || rejectedRequests ? totals.outputTokens : null,
      costComplete: dispatches > 0 && calls.length + rejectedRequests === dispatches && calls.every(({ usage }) => amount(usage?.cost)),
    };
    if (admissionError) throw admissionError;
    if (rejectedRequests) throw new StructuredModelError(usage, 'provider-limit', diagnostic);
    if (!decoded || receiptFailed) throw new StructuredModelError(usage, undefined, diagnostic);
    return { data, usage, response: responseMetadata };
  };
}

function amount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
