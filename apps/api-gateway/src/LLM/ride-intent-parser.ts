import type { GroqClient } from './groq.client';
import type { WhatsappConversationMessage } from './types';

export interface RideLocation {
  address: string;
  area: string;
  specific: boolean;
}

export interface RideIntent {
  intent: 'ride_request' | 'ride_status' | 'cancel_ride' | 'other';
  pickup: RideLocation | null;
  destination: RideLocation | null;
  offerNgn: number | null;
  paymentMethod: 'CASH' | 'WALLET' | 'CRYPTO_WALLET' | null;
}

const RIDE_INTENT_SYSTEM_PROMPT = `
You extract ride request details from WhatsApp messages.
Return ONLY a JSON object with these fields:
- "intent": "ride_request" | "ride_status" | "cancel_ride" | "other"
- "pickup": { "address": string, "area": string, "specific": boolean } | null
- "destination": { "address": string, "area": string, "specific": boolean } | null
- "offerNgn": number | null
- "paymentMethod": "WALLET" | "CRYPTO_WALLET" | "CASH" | null

"specific" field:
- true = the location is precise enough to find on a map (a street, landmark, building, mall, hotel, school, hospital, market, plaza, station, airport, bridge, gate, pier, park, etc.)
- false = just a broad area/neighborhood/city name with no specific point (e.g. "Lekki", "VI", "Ikeja", "downtown", "midtown")
- Examples of SPECIFIC (true): "Chevron roundabout Lekki", "Shoprite Ikeja", "Palms Mall", "Golden Gate Bridge", "Pier 39 San Francisco", "Union Square San Francisco", "1 Market Street San Francisco", "Unilag main gate", "SFO Airport"
- Examples of NOT SPECIFIC (false): "Lekki", "VI", "Ikeja", "San Francisco", "downtown", "Abuja"

Rules:
- If the message is about booking a ride, going somewhere, or requesting a trip → "ride_request"
- If asking about an ongoing ride status → "ride_status"
- If cancelling a ride → "cancel_ride"
- Everything else (greetings, wallet questions, general chat) → "other"
- For "other" intent, set all other fields to null
- Normalize locations: include city/state/country for clarity
  Nigerian: "VI" → "Victoria Island, Lagos", "Lekki" → "Lekki, Lagos"
  International: "Pier 39" → "Pier 39, San Francisco, CA", "Golden Gate Bridge" → "Golden Gate Bridge, San Francisco, CA"
- Extract price if mentioned (e.g., "2000", "₦2,000", "2k" → 2000, "5k" → 5000)
- If payment method not mentioned, set to null
- "wallet" or "use wallet" = "WALLET" (means Naira wallet by default)
- "crypto wallet" or "pay with crypto" or "USDC" = "CRYPTO_WALLET"
- Look at conversation history to fill in missing pickup/destination if mentioned earlier

Examples:
"I want to go from Chevron to Adeola Odeku for 2000" →
{"intent":"ride_request","pickup":{"address":"Chevron Roundabout, Lekki, Lagos","area":"Lekki","specific":true},"destination":{"address":"Adeola Odeku Street, Victoria Island, Lagos","area":"VI","specific":true},"offerNgn":2000,"paymentMethod":null}

"Take me from Lekki to VI" →
{"intent":"ride_request","pickup":{"address":"Lekki, Lagos","area":"Lekki","specific":false},"destination":{"address":"Victoria Island, Lagos","area":"VI","specific":false},"offerNgn":null,"paymentMethod":null}

"From Union Square to Pier 39" →
{"intent":"ride_request","pickup":{"address":"Union Square, San Francisco, CA","area":"San Francisco","specific":true},"destination":{"address":"Pier 39, San Francisco, CA","area":"San Francisco","specific":true},"offerNgn":null,"paymentMethod":null}

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
