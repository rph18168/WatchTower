import type { TelegramCommand, TelegramControlAdapter, TelegramSendAdapter } from '../types.ts';

export class TelegramPollingError extends Error {
  constructor() {
    super('Telegram command polling is temporarily unavailable');
    this.name = 'TelegramPollingError';
  }
}

/** Authentication and command parsing happen before any update leaves this closure. */
export function createTelegramAdapter(options: {
  botToken: string;
  personalChatId: string;
  personalUserId: string;
  fetch?: typeof fetch;
}): TelegramControlAdapter {
  const sender = createTelegramSender(options);
  if (!/^[1-9]\d*$/.test(options.personalUserId) || !Number.isSafeInteger(Number(options.personalUserId))) {
    throw new Error('A numeric personal Telegram user is required');
  }
  const endpoint = `https://api.telegram.org/bot${options.botToken}/getUpdates`;
  return {
    ...sender,
    async getUpdates({ offset }) {
      if (!Number.isSafeInteger(offset) || offset < 0) throw new TelegramPollingError();
      try {
        const response = await (options.fetch ?? fetch)(endpoint, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ offset, limit: 100, timeout: 0, allowed_updates: ['message'] }),
        });
        const value = await response.json();
        if (!response.ok || value?.ok !== true || !Array.isArray(value.result) || value.result.length > 100) throw new TelegramPollingError();
        return value.result.map((update: any) => {
          if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0 || update.update_id >= Number.MAX_SAFE_INTEGER) throw new TelegramPollingError();
          const message = update.message;
          const authorized = message?.chat?.type === 'private' && String(message.chat.id) === options.personalChatId &&
            String(message.from?.id) === options.personalUserId && message.from?.is_bot !== true;
          const match = authorized && typeof message.text === 'string' ? /^\/(digest|status|pause|resume)\s*$/.exec(message.text) : null;
          return { updateId: update.update_id, command: match ? match[1] as TelegramCommand : null };
        });
      } catch {
        // Do not retain bot URLs, raw API errors, identities or message contents.
        throw new TelegramPollingError();
      }
    },
  };
}

/** Fixed personal private receiver; secrets and identity never leave this closure. */
export function createTelegramSender(options: {
  botToken: string;
  personalChatId: string;
  fetch?: typeof fetch;
}): TelegramSendAdapter {
  if (!options.botToken.trim() || /[\s/?#]/.test(options.botToken)) throw new Error('TELEGRAM_BOT_TOKEN is required');
  if (!/^[1-9]\d*$/.test(options.personalChatId) || !Number.isSafeInteger(Number(options.personalChatId))) {
    throw new Error('A numeric personal Telegram private chat is required');
  }
  const endpoint = `https://api.telegram.org/bot${options.botToken}/sendMessage`;
  return {
    async send({ text }) {
      if (!text.trim() || text.length > 4096) return { status: 'failed', failureCode: 'rejected', permanent: true };
      try {
        const response = await (options.fetch ?? fetch)(endpoint, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: options.personalChatId, text, link_preview_options: { is_disabled: true } }),
        });
        const value = await response.json();
        if (response.ok && value?.ok === true) {
          const message = value.result;
          if (Number.isSafeInteger(message?.message_id) && message.message_id > 0 && message.chat?.type === 'private' && String(message.chat.id) === options.personalChatId) {
            return { status: 'sent', messageId: String(message.message_id) };
          }
          return { status: 'unknown', failureCode: 'invalid-response' };
        }
        if (value?.ok !== false) return { status: 'unknown', failureCode: 'invalid-response' };
        const code = value.error_code;
        if (code === 429) {
          const retry = value.parameters?.retry_after;
          return { status: 'failed', failureCode: 'rate-limited', ...(Number.isSafeInteger(retry) && retry > 0 ? { retryAfterSeconds: retry } : {}) };
        }
        if ([400, 401, 403, 404].includes(code)) {
          return { status: 'failed', failureCode: code === 403 ? 'recipient-unavailable' : 'rejected', permanent: true };
        }
        return { status: 'failed', failureCode: 'network' };
      } catch {
        // Token-bearing URLs, server descriptions and response bodies stay private.
        return { status: 'unknown', failureCode: 'network' };
      }
    },
  };
}
