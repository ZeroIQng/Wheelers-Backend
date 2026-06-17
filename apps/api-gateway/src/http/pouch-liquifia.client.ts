import { randomUUID } from "node:crypto";

// ─── Types ──────────────────────────────────────────────────────

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

interface ApiResponse<T> {
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

// ─── Client ─────────────────────────────────────────────────────

export class PouchLiquifiaClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
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

    const res = await this.post<PouchCustomer>("/customers", body);
    return res.data;
  }

  async getCustomer(customerId: string): Promise<PouchCustomer> {
    const res = await this.get<PouchCustomer>(`/customers/${customerId}`);
    return res.data;
  }

  // ── Virtual Accounts ────────────────────────────────────────

  async createVirtualAccount(
    customerId: string,
    opts?: {
      country?: string;
      currency?: string;
      fundingLimit?: number;
      settlementMode?: "held" | "auto";
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
      { "X-Idempotency-Key": randomUUID() },
    );
    return res.data;
  }

  async getVirtualAccount(
    virtualAccountId: string,
  ): Promise<PouchVirtualAccount> {
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

  async listBanks(
    country = "NG",
    currency = "NGN",
  ): Promise<PouchBankAccount[]> {
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
      country: params.country ?? "NG",
      currency: params.currency ?? "NGN",
    };
    const res = await this.post<PouchBankValidation>(
      "/payouts/validate",
      body,
    );
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
      country: params.country ?? "NG",
      currency: params.currency ?? "NGN",
    };
    if (params.reference) body.reference = params.reference;
    if (params.narration) body.narration = params.narration;

    const res = await this.post<PouchPayout>("/payouts", body, {
      "X-Idempotency-Key": params.idempotencyKey ?? randomUUID(),
    });
    return res.data;
  }

  async getPayout(payoutId: string): Promise<PouchPayout> {
    const res = await this.get<PouchPayout>(`/payouts/${payoutId}`);
    return res.data;
  }

  // ── HTTP Helpers ────────────────────────────────────────────

  private async get<T>(path: string): Promise<ApiResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method: "GET",
      headers: this.headers(),
    });
    return this.handleResponse<T>(res, "GET", path);
  }

  private async post<T>(
    path: string,
    body: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<ApiResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { ...this.headers(), ...extraHeaders },
      body: JSON.stringify(body),
    });
    return this.handleResponse<T>(res, "POST", path);
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  private async handleResponse<T>(
    res: Response,
    method: string,
    path: string,
  ): Promise<ApiResponse<T>> {
    const json = (await res.json()) as ApiResponse<T>;
    if (!res.ok || json.success === false) {
      const msg =
        json.error ?? json.message ?? `Pouch Liquifia ${method} ${path} failed`;
      const err = new Error(msg) as Error & { code?: string; status?: number };
      err.code = json.code;
      err.status = res.status;
      throw err;
    }
    return json;
  }
}
