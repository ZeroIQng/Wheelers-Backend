import { randomUUID } from 'node:crypto';
import {
  type PouchClientConfig,
  type ApiResponse,
  type PouchCustomer,
  type PouchVirtualAccount,
  type PouchVirtualAccountBalance,
  type PouchBankAccount,
  type PouchBankValidation,
  type PouchPayout,
  PouchApiError,
} from './types';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const RETRY_BACKOFF_BASE_MS = 500;

export class PouchLiquifiaClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(config: PouchClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  // ── Customers ───────────────────────────────────────────────

  async createCustomer(params: {
    customerReference: string;
    firstName: string;
    lastName: string;
    phoneNumber?: string;
    email?: string;
    bvn?: string;
  }): Promise<PouchCustomer> {
    const body: Record<string, unknown> = {
      customer_reference: params.customerReference,
      first_name: params.firstName,
      last_name: params.lastName,
    };
    if (params.phoneNumber) body.phone_number = params.phoneNumber;
    if (params.email) body.email = params.email;
    if (params.bvn) body.bvn = params.bvn;

    const res = await this.post<PouchCustomer>('/customers', body);
    return res.data;
  }

  async getCustomer(customerId: string): Promise<PouchCustomer> {
    const res = await this.get<PouchCustomer>(`/customers/${customerId}`);
    return res.data;
  }

  async findCustomerByReference(customerReference: string): Promise<PouchCustomer | null> {
    const res = await this.get<PouchCustomer[]>(
      `/customers?search=${encodeURIComponent(customerReference)}&take=10`,
    );
    const customers = Array.isArray(res.data) ? res.data : [];
    return customers.find((c) => c.customer_reference === customerReference) ?? null;
  }

  async updateCustomer(customerId: string, params: {
    email?: string;
    phoneNumber?: string;
  }): Promise<PouchCustomer> {
    const body: Record<string, unknown> = {};
    if (params.email) body.email = params.email;
    if (params.phoneNumber) body.phone_number = params.phoneNumber;
    const res = await this.patch<PouchCustomer>(`/customers/${customerId}`, body);
    return res.data;
  }

  // ── Virtual Accounts ────────────────────────────────────────

  async createVirtualAccount(
    customerId: string,
    opts?: {
      country?: string;
      currency?: string;
      fundingLimit?: number;
      settlementMode?: 'held' | 'auto';
      /** Stable idempotency key — pass the userId to prevent duplicate VAs on retry. */
      idempotencyKey?: string;
    },
  ): Promise<PouchVirtualAccount> {
    const body: Record<string, unknown> = {};
    if (opts?.country) body.country = opts.country;
    if (opts?.currency) body.currency = opts.currency;
    if (opts?.fundingLimit) body.funding_limit = opts.fundingLimit;
    if (opts?.settlementMode) body.settlement_mode = opts.settlementMode;

    const res = await this.post<PouchVirtualAccount>(
      `/customers/${customerId}/virtual-accounts`,
      body,
      { 'X-Idempotency-Key': opts?.idempotencyKey ?? randomUUID() },
    );
    return res.data;
  }

  async getVirtualAccount(virtualAccountId: string): Promise<PouchVirtualAccount> {
    const res = await this.get<PouchVirtualAccount>(
      `/virtual-accounts/${virtualAccountId}`,
    );
    return res.data;
  }

  async getVirtualAccountBalance(
    virtualAccountId: string,
  ): Promise<PouchVirtualAccountBalance> {
    const res = await this.get<PouchVirtualAccountBalance>(
      `/virtual-accounts/${virtualAccountId}/balance`,
    );
    return res.data;
  }

  // ── Banks ───────────────────────────────────────────────────

  async listBanks(country = 'NG', currency = 'NGN'): Promise<PouchBankAccount[]> {
    const res = await this.get<{ banks: PouchBankAccount[] }>(
      `/banks?country=${country}&currency=${currency}`,
    );
    return res.data.banks;
  }

  // ── Payouts ─────────────────────────────────────────────────

  async validateBankAccount(params: {
    accountNumber: string;
    bankUuid: string;
    country?: string;
    currency?: string;
  }): Promise<PouchBankValidation> {
    const body = {
      account_number: params.accountNumber,
      bank_uuid: params.bankUuid,
      country: params.country ?? 'NG',
      currency: params.currency ?? 'NGN',
    };
    const res = await this.post<PouchBankValidation>('/payouts/validate', body);
    return res.data;
  }

  async createPayout(params: {
    virtualAccountId: string;
    reference?: string;
    amount: number;
    destinationAccount: string;
    destinationBankUuid: string;
    country?: string;
    currency?: string;
    narration?: string;
    idempotencyKey?: string;
  }): Promise<PouchPayout> {
    const body: Record<string, unknown> = {
      virtual_account_id: params.virtualAccountId,
      amount: params.amount,
      destination_account: params.destinationAccount,
      destination_bank_uuid: params.destinationBankUuid,
      country: params.country ?? 'NG',
      currency: params.currency ?? 'NGN',
    };
    if (params.reference) body.reference = params.reference;
    if (params.narration) body.narration = params.narration;

    const res = await this.post<PouchPayout>('/payouts', body, {
      'X-Idempotency-Key': params.idempotencyKey ?? randomUUID(),
    });
    return res.data;
  }

  async getPayout(payoutId: string): Promise<PouchPayout> {
    const res = await this.get<PouchPayout>(`/payouts/${payoutId}`);
    return res.data;
  }

  // ── HTTP Helpers ────────────────────────────────────────────

  private async get<T>(path: string): Promise<ApiResponse<T>> {
    return this.requestWithRetry<T>('GET', path);
  }

  private async patch<T>(
    path: string,
    body: unknown,
  ): Promise<ApiResponse<T>> {
    return this.requestWithRetry<T>('PATCH', path, body);
  }

  private async post<T>(
    path: string,
    body: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<ApiResponse<T>> {
    return this.requestWithRetry<T>('POST', path, body, extraHeaders);
  }

  private async requestWithRetry<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<ApiResponse<T>> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.request<T>(method, path, body, extraHeaders);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Don't retry client errors (4xx) — only retry network/server errors
        if (error instanceof PouchApiError && error.status && error.status < 500) {
          throw error;
        }

        if (attempt < this.maxRetries) {
          const delay = RETRY_BACKOFF_BASE_MS * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError!;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<ApiResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        method,
        headers: { ...this.headers(), ...extraHeaders },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const json = (await res.json()) as ApiResponse<T>;

      if (!res.ok || json.success === false) {
        const raw = json.error ?? json.message ?? `Pouch Liquifia ${method} ${path} failed`;
        const msg = typeof raw === 'string' ? raw : JSON.stringify(raw);
        throw new PouchApiError(msg, res.status, json.code);
      }

      return json;
    } catch (error) {
      if (error instanceof PouchApiError) throw error;

      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new PouchApiError(
          `Pouch Liquifia ${method} ${path} timed out after ${this.timeoutMs}ms`,
          408,
        );
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }
}
