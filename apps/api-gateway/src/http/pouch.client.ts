import type { PaymentSessionType } from '@prisma/client';

export interface PouchOnrampPayload extends Record<string, unknown> {
  amount: number;
  cryptoCurrency: string;
  cryptoNetwork: string;
  walletAddress: string;
  walletTag?: string;
  countryCode: string;
  currency: string;
  providerId: string;
  userKyc?: Record<string, unknown>;
}

export interface PouchOfframpPayload extends Record<string, unknown> {
  cryptoAmount: number;
  cryptoCurrency: string;
  cryptoNetwork: string;
  countryCode: string;
  currency: string;
  providerId: string;
  bankAccount: {
    accountNumber: string;
    accountName: string;
    networkId: string;
  };
  userKyc?: Record<string, unknown>;
}

export interface PouchOnrampResponse extends Record<string, unknown> {
  paymentInstruction?: {
    accountNumber?: string;
    accountName?: string;
    bankName?: string;
    amountUsd?: number;
    amountLocal?: number;
    localCurrency?: string;
    fxRate?: number;
    cryptoAmount?: number;
    cryptoCurrency?: string;
    cryptoNetwork?: string;
    fees?: {
      networkFee?: number;
      serviceFee?: number;
      totalFees?: number;
    };
    reference?: string;
    expiresAt?: string;
  };
  providerRef?: string;
}

export interface PouchOfframpResponse extends Record<string, unknown> {
  cryptoInstruction?: {
    walletAddress?: string;
    cryptoNetwork?: string;
    cryptoCurrency?: string;
    cryptoAmount?: number;
    amountUsd?: number;
    amountLocal?: number;
    localCurrency?: string;
    fxRate?: number;
    fees?: {
      networkFee?: number;
      serviceFee?: number;
      totalFees?: number;
    };
    reference?: string;
    expiresAt?: string;
  };
  providerRef?: string;
}

export interface PouchRampStatusResponse extends Record<string, unknown> {
  providerRef?: string;
  status?: string;
  type?: PaymentSessionType;
  transactionHash?: string;
  settlementInfo?: Record<string, unknown>;
  details?: Record<string, unknown>;
  failureReason?: string;
}

export class PouchApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody?: unknown,
  ) {
    super(message);
    this.name = 'PouchApiError';
  }
}

export class PouchClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  health(): Promise<Record<string, unknown>> {
    return this.request('GET', '/health', { auth: false });
  }

  createSharedKycOnramp(payload: PouchOnrampPayload): Promise<PouchOnrampResponse> {
    return this.request('POST', '/shared-kyc/ramp/onramp', {
      body: payload,
      auth: !payload.userKyc,
    });
  }

  createSharedKycOfframp(payload: PouchOfframpPayload): Promise<PouchOfframpResponse> {
    return this.request('POST', '/shared-kyc/ramp/offramp', {
      body: payload,
      auth: !payload.userKyc,
    });
  }

  getRampStatus(
    providerRef: string,
    type?: PaymentSessionType,
  ): Promise<PouchRampStatusResponse> {
    const path = new URL(
      `/shared-kyc/ramp/status/${encodeURIComponent(providerRef)}`,
      this.baseUrl,
    );

    if (type) {
      path.searchParams.set('type', type);
    }

    return this.request('GET', path);
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string | URL,
    options?: {
      body?: Record<string, unknown>;
      auth?: boolean;
    },
  ): Promise<T> {
    const auth = options?.auth ?? true;
    const headers: Record<string, string> = {
      accept: 'application/json',
    };

    if (auth) {
      const apiKey = this.apiKey.replace(/^Bearer\s+/i, '').trim();
      headers.authorization = `Bearer ${apiKey}`;
      headers['x-api-key'] = apiKey;
      headers['x-pouch-api-key'] = apiKey;
    }

    if (options?.body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    const requestUrl = path instanceof URL ? path : new URL(path, this.baseUrl);

    console.log('[api-gateway][pouch-client] request', {
      method,
      url: requestUrl.toString(),
      auth,
      apiKeyFingerprint: auth ? fingerprintApiKey(this.apiKey) : null,
      bodyKeys: options?.body ? Object.keys(options.body) : [],
    });

    const response = await fetch(
      requestUrl,
      {
        method,
        headers,
        body: options?.body === undefined ? undefined : JSON.stringify(options.body),
      },
    );

    const contentType = response.headers.get('content-type') ?? '';
    const payload = contentType.includes('application/json')
      ? await response.json()
      : await response.text();

    console.log('[api-gateway][pouch-client] response', {
      method,
      url: requestUrl.toString(),
      status: response.status,
      ok: response.ok,
      contentType,
    });

    if (!response.ok) {
      throw new PouchApiError('Pouch request failed', response.status, payload);
    }

    return payload as T;
  }
}

function fingerprintApiKey(value: string): string {
  const normalized = value.replace(/^Bearer\s+/i, '').trim();
  if (normalized.length <= 8) {
    return normalized;
  }

  return `${normalized.slice(0, 4)}...${normalized.slice(-4)}`;
}
