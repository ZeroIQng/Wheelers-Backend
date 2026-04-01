/**
 * Event registry - Union of all events for type narrowing
 * This allows for discriminated union types when consuming events
 */

import type { RideEvent } from './events/ride.events';
import type { PaymentEvent } from './events/payment.events';
import type { WalletEvent } from './events/wallet.events';
import type { GPSEvent } from './events/gps.events';
import type { DefiEvent } from './events/defi.events';
import type { ComplianceEvent } from './events/compliance.events';

export type AllEvents =
  | RideEvent
  | PaymentEvent
  | WalletEvent
  | GPSEvent
  | DefiEvent
  | ComplianceEvent;

/**
 * Type guard to check if an event is a ride event
 */
export function isRideEvent(event: AllEvents): event is RideEvent {
  return event.type.startsWith('ride.');
}

/**
 * Type guard to check if an event is a payment event
 */
export function isPaymentEvent(event: AllEvents): event is PaymentEvent {
  return event.type.startsWith('payment.');
}

/**
 * Type guard to check if an event is a wallet event
 */
export function isWalletEvent(event: AllEvents): event is WalletEvent {
  return event.type.startsWith('wallet.');
}

/**
 * Type guard to check if an event is a GPS event
 */
export function isGPSEvent(event: AllEvents): event is GPSEvent {
  return event.type.startsWith('gps.');
}

/**
 * Type guard to check if an event is a DeFi event
 */
export function isDefiEvent(event: AllEvents): event is DefiEvent {
  return event.type.startsWith('defi.');
}

/**
 * Type guard to check if an event is a compliance event
 */
export function isComplianceEvent(event: AllEvents): event is ComplianceEvent {
  return event.type.startsWith('compliance.');
}
