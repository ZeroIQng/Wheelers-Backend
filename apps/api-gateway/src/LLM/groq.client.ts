import type { LlmChatMessage } from './types';

const GROQ_CHAT_COMPLETIONS_URL = 'https://api.groq.com/openai/v1/chat/completions';

export interface GroqClientConfig {
  apiKey?: string;
  model: string;
  timeoutMs: number;
}

interface GroqChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  error?: {
    message?: string;
  };
}

export class GroqClient {
  constructor(private readonly config: GroqClientConfig) {}

  get configured(): boolean {
    return Boolean(this.config.apiKey);
  }

  async complete(messages: LlmChatMessage[]): Promise<string | null> {
    return this.chat(messages, false);
  }

  async completeJson(messages: LlmChatMessage[]): Promise<Record<string, unknown> | null> {
    const raw = await this.chat(messages, true);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      console.warn('[groq] Failed to parse JSON response', { raw: raw.slice(0, 200) });
      return null;
    }
  }

  private async chat(messages: LlmChatMessage[], jsonMode: boolean): Promise<string | null> {
    if (!this.config.apiKey) {
      return null;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const body: Record<string, unknown> = {
        model: this.config.model,
        messages,
        temperature: jsonMode ? 0.1 : 0.4,
        max_completion_tokens: jsonMode ? 300 : 420,
      };
      if (jsonMode) {
        body.response_format = { type: 'json_object' };
      }

      const response = await fetch(GROQ_CHAT_COMPLETIONS_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const payload = (await response.json().catch(() => null)) as GroqChatCompletionResponse | null;
      if (!response.ok) {
        const message = payload?.error?.message ?? `Groq request failed with status ${response.status}`;
        throw new Error(message);
      }

      const content = payload?.choices?.[0]?.message?.content?.trim();
      return content || null;
    } finally {
      clearTimeout(timeout);
    }
  }
}

