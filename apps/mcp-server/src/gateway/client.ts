/**
 * Thin typed wrapper over the api-gateway HTTP API. The MCP server never
 * touches the database — every read and write goes through the same routes
 * the mobile app uses, with the user's own access token, so gateway-side
 * invariants (escrow holds, outbox events, notifications) always apply.
 */

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

export interface GatewayUser {
  id: string;
  privyDid?: string;
  username?: string | null;
  email: string | null;
  role: 'RIDER' | 'DRIVER' | 'BOTH';
  name: string | null;
  phone: string | null;
  isNewUser?: boolean;
}

export interface AuthResponse {
  accessToken: string;
  tokenType: 'Bearer';
  user: GatewayUser;
  created?: boolean;
}

type Query = Record<string, string | number | boolean | undefined | null>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class GatewayClient {
  constructor(
    private readonly baseUrl: string,
    private readonly accessToken?: string,
  ) {}

  withToken(token: string): GatewayClient {
    return new GatewayClient(this.baseUrl, token);
  }

  async get<T = unknown>(path: string, query?: Query): Promise<T> {
    return this.request<T>('GET', path, undefined, query);
  }

  async post<T = unknown>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
    return this.request<T>('POST', path, body ?? {}, undefined, headers);
  }

  async put<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, body ?? {});
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Query,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const url = new URL(path, this.baseUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue;
        url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      accept: 'application/json',
      ...extraHeaders,
    };
    if (this.accessToken) headers['authorization'] = `Bearer ${this.accessToken}`;
    if (body !== undefined) headers['content-type'] = 'application/json';

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new GatewayError(
        `Could not reach Wheelers API (${method} ${path}): ${error instanceof Error ? error.message : String(error)}`,
        0,
        'GATEWAY_UNREACHABLE',
        null,
      );
    }

    const text = await response.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!response.ok) {
      const message =
        isRecord(parsed) && typeof parsed['error'] === 'string'
          ? parsed['error']
          : `Wheelers API returned HTTP ${response.status} for ${method} ${path}`;
      const code = isRecord(parsed) && typeof parsed['code'] === 'string' ? parsed['code'] : undefined;
      throw new GatewayError(message, response.status, code, parsed);
    }

    return parsed as T;
  }

  // ── Auth (unauthenticated) ────────────────────────────────────────────────

  signin(identifier: string, password: string): Promise<AuthResponse> {
    return this.post<AuthResponse>('/auth/signin', { identifier, password });
  }

  signup(input: {
    fullName?: string;
    email?: string;
    username?: string;
    phone?: string;
    password: string;
    role?: 'RIDER' | 'DRIVER' | 'BOTH';
  }): Promise<AuthResponse> {
    return this.post<AuthResponse>('/auth/signup', input);
  }

  phoneLoginSendOtp(phone: string): Promise<{ sent: boolean; channel: 'whatsapp' | 'sms'; phone: string; expiresInSeconds: number }> {
    return this.post('/auth/phone/login/send-otp', { phone });
  }

  phoneLoginVerify(phone: string, code: string): Promise<AuthResponse & { isNewUser: boolean }> {
    return this.post('/auth/phone/login/verify-otp', { phone, code });
  }

  me(): Promise<{ user: GatewayUser }> {
    return this.get<{ user: GatewayUser }>('/auth/me');
  }
}
