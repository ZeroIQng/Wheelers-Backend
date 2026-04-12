import https from 'node:https';

export interface PaystackInitializeTransactionInput {
  email: string;
  amountKobo: number;
  reference: string;
  callbackUrl?: string;
  channels?: string[];
  metadata?: Record<string, unknown>;
}

export interface PaystackInitializeTransactionResponse {
  authorization_url: string;
  access_code: string;
  reference: string;
}

export interface PaystackVerifyTransactionResponse {
  id?: number;
  domain?: string;
  status?: string;
  reference?: string;
  amount?: number;
  message?: string;
  gateway_response?: string;
  paid_at?: string;
  channel?: string;
  currency?: string;
  customer?: {
    email?: string;
  };
  metadata?: unknown;
  authorization?: Record<string, unknown>;
}

interface PaystackEnvelope<T> {
  status: boolean;
  message: string;
  data: T;
}

export class PaystackApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody?: unknown,
  ) {
    super(message);
    this.name = 'PaystackApiError';
  }
}

export class PaystackClient {
  constructor(
    private readonly baseUrl: string,
    private readonly secretKey: string,
  ) {}

  initializeTransaction(
    input: PaystackInitializeTransactionInput,
  ): Promise<PaystackInitializeTransactionResponse> {
    return this.request('/transaction/initialize', 'POST', {
      email: input.email,
      amount: input.amountKobo,
      reference: input.reference,
      callback_url: input.callbackUrl,
      channels: input.channels,
      metadata: input.metadata,
      currency: 'NGN',
    });
  }

  verifyTransaction(reference: string): Promise<PaystackVerifyTransactionResponse> {
    return this.request(
      `/transaction/verify/${encodeURIComponent(reference)}`,
      'GET',
    );
  }

  private async request<T>(
    path: string,
    method: 'GET' | 'POST',
    payload?: Record<string, unknown>,
  ): Promise<T> {
    const url = new URL(path, this.baseUrl);
    const body = payload ? JSON.stringify(payload) : undefined;

    return new Promise<T>((resolve, reject) => {
      const request = https.request(
        url,
        {
          method,
          headers: {
            authorization: `Bearer ${this.secretKey}`,
            accept: 'application/json',
            ...(body
              ? {
                  'content-type': 'application/json',
                  'content-length': Buffer.byteLength(body),
                }
              : {}),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];

          response.on('data', (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });

          response.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            let parsed: unknown = raw;

            if (raw.length > 0) {
              try {
                parsed = JSON.parse(raw);
              } catch {
                reject(
                  new PaystackApiError(
                    'Paystack returned a non-JSON response',
                    response.statusCode ?? 500,
                    raw,
                  ),
                );
                return;
              }
            }

            if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
              reject(
                new PaystackApiError(
                  'Paystack request failed',
                  response.statusCode ?? 500,
                  parsed,
                ),
              );
              return;
            }

            const envelope = parsed as PaystackEnvelope<T>;
            if (!envelope || envelope.status !== true) {
              reject(
                new PaystackApiError(
                  'Paystack returned an unsuccessful response',
                  response.statusCode,
                  parsed,
                ),
              );
              return;
            }

            resolve(envelope.data);
          });
        },
      );

      request.on('error', reject);

      if (body) {
        request.write(body);
      }

      request.end();
    });
  }
}
