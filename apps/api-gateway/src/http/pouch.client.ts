export interface PouchSessionPayload extends Record<string, unknown> {
  type: 'ONRAMP' | 'OFFRAMP';
  amount: number;
  countryCode: string;
  currency: string;
  cryptoCurrency: string;
  cryptoNetwork: string;
  walletAddress: string;
}

export interface PouchSessionResponse extends Record<string, unknown> {
  id?: string;
  type?: string;
  status?: string;
  amount?: number;
  currency?: string;
  cryptoCurrency?: string;
  cryptoNetwork?: string;
  chain?: string;
  walletAddress?: string;
  walletTag?: string;
  metadata?: unknown;
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

  getCryptoChannels(): Promise<Record<string, unknown>> {
    return this.request('GET', '/crypto/channels');
  }

  createSession(payload: PouchSessionPayload): Promise<PouchSessionResponse> {
    return this.request('POST', '/v2/sessions', { body: payload });
  }

  getSession(sessionId: string): Promise<PouchSessionResponse> {
    return this.request('GET', `/v2/sessions/${encodeURIComponent(sessionId)}`);
  }

  getSessionQuote(sessionId: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/v2/sessions/${encodeURIComponent(sessionId)}/quote`);
  }

  identifySession(sessionId: string, email: string): Promise<Record<string, unknown>> {
    return this.request('POST', `/v2/sessions/${encodeURIComponent(sessionId)}/identify`, {
      body: { email },
    });
  }

  verifyOtp(sessionId: string, code: string): Promise<Record<string, unknown>> {
    return this.request('POST', `/v2/sessions/${encodeURIComponent(sessionId)}/verify-otp`, {
      body: { code },
    });
  }

  getKycRequirements(sessionId: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/v2/sessions/${encodeURIComponent(sessionId)}/kyc-requirements`);
  }

  submitKyc(
    sessionId: string,
    documents: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request('POST', `/v2/sessions/${encodeURIComponent(sessionId)}/kyc`, {
      body: { documents },
    });
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
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
      headers['x-api-key'] = this.apiKey;
    }

    if (options?.body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    const response = await fetch(new URL(path, this.baseUrl), {
      method,
      headers,
      body: options?.body === undefined ? undefined : JSON.stringify(options.body),
    });

    const contentType = response.headers.get('content-type') ?? '';
    const payload = contentType.includes('application/json')
      ? await response.json()
      : await response.text();

    if (!response.ok) {
      throw new PouchApiError(
        'Pouch request failed',
        response.status,
        payload,
      );
    }

    return payload as T;
  }
}
