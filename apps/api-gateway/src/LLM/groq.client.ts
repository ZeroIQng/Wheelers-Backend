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
    if (!this.config.apiKey) {
      return null;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(GROQ_CHAT_COMPLETIONS_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          temperature: 0.4,
          max_completion_tokens: 420,
        }),
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

