import type { GroqClient } from './groq.client';
import type { WhatsappConversationMessage } from './types';

export interface RideIntent {
  intent: 'ride_request' | 'ride_status' | 'cancel_ride' | 'other';
  pickup: { address: string; area: string } | null;
  destination: { address: string; area: string } | null;
  offerNgn: number | null;
  paymentMethod: 'CASH' | 'WALLET' | null;
}

const RIDE_INTENT_SYSTEM_PROMPT = `
You extract ride request details from Nigerian WhatsApp messages.
Return ONLY a JSON object with these fields:
- "intent": "ride_request" | "ride_status" | "cancel_ride" | "other"
- "pickup": { "address": string, "area": string } | null
- "destination": { "address": string, "area": string } | null
- "offerNgn": number | null
- "paymentMethod": "WALLET" | "CASH" | null

Rules:
- If the message is about booking a ride, going somewhere, or requesting a trip → "ride_request"
- If asking about an ongoing ride status → "ride_status"
- If cancelling a ride → "cancel_ride"
- Everything else (greetings, wallet questions, general chat) → "other"
- For "other" intent, set all other fields to null
- Normalize Nigerian locations:
  "VI" → "Victoria Island, Lagos"
  "Lekki" → "Lekki, Lagos"
  "Ajah" → "Ajah, Lagos"
  "Ikoyi" → "Ikoyi, Lagos"
  "Yaba" → "Yaba, Lagos"
  "Surulere" → "Surulere, Lagos"
  "Ikeja" → "Ikeja, Lagos"
  "Maryland" → "Maryland, Lagos"
  "Festac" → "Festac Town, Lagos"
  "Oshodi" → "Oshodi, Lagos"
  "Berger" → "Berger, Lagos"
  "Ojodu" → "Ojodu, Lagos"
  "Abule Egba" → "Abule Egba, Lagos"
  For non-Lagos cities, include the state (e.g., "Garki, Abuja")
- Extract price if mentioned (e.g., "2000", "₦2,000", "2k" → 2000, "5k" → 5000)
- If payment method not mentioned, set to null
- Look at conversation history to fill in missing pickup/destination if mentioned earlier

Examples:
"I want to go from Lekki to VI for 2000" →
{"intent":"ride_request","pickup":{"address":"Lekki, Lagos","area":"Lekki"},"destination":{"address":"Victoria Island, Lagos","area":"VI"},"offerNgn":2000,"paymentMethod":null}

"Book a ride to Ikeja" →
{"intent":"ride_request","pickup":null,"destination":{"address":"Ikeja, Lagos","area":"Ikeja"},"offerNgn":null,"paymentMethod":null}

"Cancel my ride" →
{"intent":"cancel_ride","pickup":null,"destination":null,"offerNgn":null,"paymentMethod":null}

"Hello how are you" →
{"intent":"other","pickup":null,"destination":null,"offerNgn":null,"paymentMethod":null}
`.trim();

/** Regex fallback for critical intents when Groq is unavailable. */
function fallbackRideIntent(message: string): RideIntent | null {
  const lower = message.toLowerCase().trim();
  if (/\b(cancel\s*(my\s*)?ride|stop\s*(my\s*)?ride)\b/.test(lower)) {
    return { intent: 'cancel_ride', pickup: null, destination: null, offerNgn: null, paymentMethod: null };
  }
  if (/\b(ride\s*status|where.*driver|how\s*far)\b/.test(lower)) {
    return { intent: 'ride_status', pickup: null, destination: null, offerNgn: null, paymentMethod: null };
  }
  return null;
}

export async function parseRideIntent(
  groq: GroqClient,
  message: string,
  recentMessages: WhatsappConversationMessage[],
): Promise<RideIntent | null> {
  if (!groq.configured) return fallbackRideIntent(message);

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: RIDE_INTENT_SYSTEM_PROMPT },
  ];

  // Include last 4 messages for context (pickup/destination from prior messages)
  const contextMessages = recentMessages.slice(-4);
  for (const msg of contextMessages) {
    messages.push({ role: msg.role, content: msg.content });
  }

  messages.push({ role: 'user', content: message });

  try {
    const result = await groq.completeJson(messages);
    if (!result) return null;

    const intent = result as unknown as RideIntent;
    if (!intent.intent || !['ride_request', 'ride_status', 'cancel_ride', 'other'].includes(intent.intent)) {
      return null;
    }

    return intent;
  } catch (error) {
    console.warn('[ride-intent] Parse failed, trying regex fallback', {
      error: error instanceof Error ? error.message : String(error),
    });
    return fallbackRideIntent(message);
  }
}
