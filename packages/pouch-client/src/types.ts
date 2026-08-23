// ─── Response Types ─────────────────────────────────────────────

export interface PouchCustomer {
  id: string;
  customer_reference: string;
  first_name: string;
  last_name: string;
  phone_number?: string;
  email?: string;
  bvn?: string;
  created_at: string;
  updated_at: string;
}

export interface PouchVirtualAccount {
  id: string;
  integrator_id: string;
  customer_id: string;
  account_reference: string;
  account_number: string;
  account_name: string;
  bank_name: string;
  funding_limit?: number;
  status: string;
  provider: string;
  country: string;
  currency: string;
  settlement_mode: string;
  created_at: string;
  updated_at: string;
}

export interface PouchVirtualAccountBalance {
  virtual_account_id: string;
  account_number: string;
  customer_id: string;
  balance: number;
  currency: string;
  country: string;
  transfers_count: number;
  payouts_count: number;
}

export interface PouchBankAccount {
  uuid: string;
  name: string;
  code: string;
  country: string;
  currency: string;
  provider: string;
}

export interface PouchBankValidation {
  account_number: string;
  account_name: string;
  bank_name: string;
  bank_code: string;
}

export interface PouchPayout {
  id: string;
  reference: string;
  amount: number;
  fee: number;
  destination_account: string;
  destination_bank_name: string;
  recipient_name: string;
  narration?: string;
  status: string;
  country: string;
  currency: string;
  created_at: string;
}

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  message?: string;
  error?: string;
  code?: string;
  pagination?: {
    total: number;
    skip: number;
    take: number;
    has_more: boolean;
  };
}

export interface PouchClientConfig {
  baseUrl: string;
  apiKey: string;
  /** Request timeout in ms. Default: 30_000 */
  timeoutMs?: number;
  /** Max retry attempts for transient failures. Default: 2 */
  maxRetries?: number;
}

export class PouchApiError extends Error {
  code?: string;
  status?: number;

  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = 'PouchApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Pouch reports payout state as a free-form string, and a payout it has
 * already rejected still comes back as an HTTP 200 — callers that only check
 * for a thrown error treat those rejections as successes. Every caller that
 * receives a PouchPayout must classify its status through this function.
 */
export type PouchPayoutOutcome = 'settled' | 'failed' | 'pending';

const SETTLED_PAYOUT_STATUSES = new Set(['SUCCESSFUL', 'SUCCESS', 'COMPLETED', 'SETTLED']);
const FAILED_PAYOUT_STATUSES = new Set([
  'FAILED',
  'FAILURE',
  'REVERSED',
  'CANCELLED',
  'CANCELED',
  'REJECTED',
  'DECLINED',
  'RETURNED',
  'EXPIRED',
]);

export function classifyPouchPayoutStatus(status: string | null | undefined): PouchPayoutOutcome {
  const normalized = (status ?? '').trim().toUpperCase();
  if (SETTLED_PAYOUT_STATUSES.has(normalized)) return 'settled';
  if (FAILED_PAYOUT_STATUSES.has(normalized)) return 'failed';
  return 'pending';
}
