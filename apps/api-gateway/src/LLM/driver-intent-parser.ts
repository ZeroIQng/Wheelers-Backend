import type { GroqClient } from './groq.client';
import type { WhatsappConversationMessage } from './types';

export interface DriverIntent {
  intent: 'go_online' | 'go_offline' | 'bid' | 'check_earnings' | 'other';
  bidRideIndex: number | null;
  bidAmountNgn: number | null;
}

const DRIVER_INTENT_SYSTEM_PROMPT = `
You extract driver intents from Nigerian WhatsApp messages for a ride-hailing driver app.
Return ONLY a JSON object with these fields:
- "intent": "go_online" | "go_offline" | "bid" | "check_earnings" | "other"
- "bidRideIndex": number | null (0-based index if driver says "first ride", "second", etc. — default 0)
- "bidAmountNgn": number | null

Rules:
- "go online", "start", "I'm ready", "available" → "go_online"
- "go offline", "stop", "done for today", "I'm done" → "go_offline"
- "bid 2000", "offer 3000", "I'll do it for 2500", "accept", "2k" → "bid" with bidAmountNgn
- "accept" or "accept ride" without a price → "bid" with bidAmountNgn null (means accept at rider's price)
- "earnings", "how much today", "my stats" → "check_earnings"
- Everything else → "other"
- Extract prices: "2000", "₦2,000", "2k" → 2000, "5k" → 5000
- If driver says "bid 2000 on the second ride", bidRideIndex = 1

Examples:
"I'm available" → {"intent":"go_online","bidRideIndex":null,"bidAmountNgn":null}
"bid 3500" → {"intent":"bid","bidRideIndex":0,"bidAmountNgn":3500}
"accept" → {"intent":"bid","bidRideIndex":0,"bidAmountNgn":null}
"bid 2k on second ride" → {"intent":"bid","bidRideIndex":1,"bidAmountNgn":2000}
"done for today" → {"intent":"go_offline","bidRideIndex":null,"bidAmountNgn":null}
"how much have I made" → {"intent":"check_earnings","bidRideIndex":null,"bidAmountNgn":null}
"hello" → {"intent":"other","bidRideIndex":null,"bidAmountNgn":null}
`.trim();

/** Regex fallback for critical driver intents when Groq is unavailable. */
function fallbackDriverIntent(message: string): DriverIntent | null {
  const lower = message.toLowerCase().trim();
  if (/\b(go\s*online|i'?m\s*(ready|available)|start)\b/.test(lower)) {
    return { intent: 'go_online', bidRideIndex: null, bidAmountNgn: null };
  }
  if (/\b(go\s*offline|i'?m\s*done|stop|done\s*for\s*(the\s*)?day)\b/.test(lower)) {
    return { intent: 'go_offline', bidRideIndex: null, bidAmountNgn: null };
  }
  if (/\b(earnings|how\s*much|my\s*stats)\b/.test(lower)) {
    return { intent: 'check_earnings', bidRideIndex: null, bidAmountNgn: null };
  }
  // Match "accept" or "bid <amount>"
  const bidMatch = lower.match(/\b(?:bid|offer)\s+(\d+(?:,\d{3})*(?:\.\d+)?k?)\b/);
  if (bidMatch) {
    let amount = bidMatch[1].replace(/,/g, '');
    if (amount.endsWith('k')) amount = String(parseFloat(amount) * 1000);
    return { intent: 'bid', bidRideIndex: 0, bidAmountNgn: parseFloat(amount) || null };
  }
  if (/\baccept\b/.test(lower)) {
    return { intent: 'bid', bidRideIndex: 0, bidAmountNgn: null };
  }
  return null;
}

export async function parseDriverIntent(
  groq: GroqClient,
  message: string,
  recentMessages: WhatsappConversationMessage[],
): Promise<DriverIntent | null> {
  if (!groq.configured) return fallbackDriverIntent(message);

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: DRIVER_INTENT_SYSTEM_PROMPT },
  ];

  const contextMessages = recentMessages.slice(-4);
  for (const msg of contextMessages) {
    messages.push({ role: msg.role, content: msg.content });
  }

  messages.push({ role: 'user', content: message });

  try {
    const result = await groq.completeJson(messages);
    if (!result) return null;

    const intent = result as unknown as DriverIntent;
    if (!intent.intent || !['go_online', 'go_offline', 'bid', 'check_earnings', 'other'].includes(intent.intent)) {
      return null;
    }

    return intent;
  } catch (error) {
    console.warn('[driver-intent] Parse failed, trying regex fallback', {
      error: error instanceof Error ? error.message : String(error),
    });
    return fallbackDriverIntent(message);
  }
}
