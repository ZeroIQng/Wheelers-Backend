/**
 * Payment-related events
 */

export interface PaymentInitiatedEvent {
  type: 'payment.initiated';
  data: {
    paymentId: string;
    rideId: string;
    amount: number;
    currency: string;
    method: 'card' | 'wallet' | 'upi' | 'cash';
    initiatedAt: Date;
  };
}

export interface PaymentProcessedEvent {
  type: 'payment.processed';
  data: {
    paymentId: string;
    rideId: string;
    amount: number;
    currency: string;
    processedAt: Date;
    transactionId: string;
  };
}

export interface PaymentFailedEvent {
  type: 'payment.failed';
  data: {
    paymentId: string;
    rideId: string;
    amount: number;
    reason: string;
    failedAt: Date;
    retryCount: number;
  };
}

export interface PaymentRefundedEvent {
  type: 'payment.refunded';
  data: {
    paymentId: string;
    rideId: string;
    refundAmount: number;
    refundedAt: Date;
    reason: string;
  };
}

export type PaymentEvent =
  | PaymentInitiatedEvent
  | PaymentProcessedEvent
  | PaymentFailedEvent
  | PaymentRefundedEvent;
