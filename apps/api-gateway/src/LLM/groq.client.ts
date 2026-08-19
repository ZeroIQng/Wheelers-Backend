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

/**
 * Reasoning budget for JSON extraction calls. Empty string disables the
 * parameter entirely, for models that reject it.
 */
const REASONING_EFFORT = (process.env['GROQ_REASONING_EFFORT'] ?? 'low').trim();

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
        // Reasoning models (gpt-oss) spend completion tokens thinking before
        // they emit anything. At the old 300 the budget ran out mid-object and
        // Groq rejected the truncated result with "Failed to generate JSON" —
        // measured at 1 failure in 3. Every failure fell back to regex, which
        // is why a plain address silently stopped being understood.
        max_completion_tokens: jsonMode ? 700 : 600,
      };
      if (jsonMode) {
        body.response_format = { type: 'json_object' };
        // Extraction needs no deep reasoning, and capping it keeps the reply
        // inside the budget. Set GROQ_REASONING_EFFORT='' for models that do
        // not accept the parameter.
        if (REASONING_EFFORT) {
          body.reasoning_effort = REASONING_EFFORT;
        }
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

