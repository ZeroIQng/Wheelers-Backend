import https from 'node:https';

interface CoinbaseExchangeRatesResponse {
  data?: {
    currency?: string;
    rates?: Record<string, string>;
  };
}

export class CoinbaseRatesClient {
  private cachedRate:
    | {
        ngnPerUsd: number;
        expiresAt: number;
      }
    | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly ttlMs: number,
  ) {}

  async getNgnPerUsdRate(): Promise<number> {
    if (this.cachedRate && this.cachedRate.expiresAt > Date.now()) {
      return this.cachedRate.ngnPerUsd;
    }

    const url = new URL(this.baseUrl);
    url.searchParams.set('currency', 'USD');

    const payload = await this.request(url);
    const rate = Number(payload.data?.rates?.['NGN']);

    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error('Coinbase exchange rates response did not include a valid NGN rate');
    }

    this.cachedRate = {
      ngnPerUsd: rate,
      expiresAt: Date.now() + this.ttlMs,
    };

    return rate;
  }

  private async request(url: URL): Promise<CoinbaseExchangeRatesResponse> {
    return new Promise<CoinbaseExchangeRatesResponse>((resolve, reject) => {
      const request = https.request(
        url,
        {
          method: 'GET',
          headers: {
            accept: 'application/json',
          },
        },
        (response) => {
          const chunks: Buffer[] = [];

          response.on('data', (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });

          response.on('end', () => {
            const rawBody = Buffer.concat(chunks).toString('utf8');

            if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
              reject(
                new Error(
                  `Coinbase exchange rates request failed with status ${response.statusCode ?? 500}`,
                ),
              );
              return;
            }

            try {
              resolve(JSON.parse(rawBody) as CoinbaseExchangeRatesResponse);
            } catch {
              reject(new Error('Coinbase exchange rates response was not valid JSON'));
            }
          });
        },
      );

      request.on('error', reject);
      request.end();
    });
  }
}
