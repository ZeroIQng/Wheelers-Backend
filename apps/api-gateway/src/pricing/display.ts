const DEFAULT_RIDE_DISPLAY_CURRENCY = 'NGN';
const COINGECKO_TETHER_PRICE_PATH =
  '/simple/price?ids=tether&vs_currencies=ngn&precision=2';

export type RidePricingDisplay = {
  displayCurrency: 'NGN';
  displayExchangeRate: number;
};

export type RidePricingDisplayProvider = {
  getPricingDisplay(): Promise<RidePricingDisplay>;
};

export class CoinGeckoRidePricingDisplayProvider implements RidePricingDisplayProvider {
  private cachedPricing: RidePricingDisplay | null = null;
  private cachedAt = 0;
  private inFlight: Promise<RidePricingDisplay> | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly ttlMs: number,
    private readonly fallbackNgnPerUsdt: number,
  ) {}

  async getPricingDisplay(): Promise<RidePricingDisplay> {
    const now = Date.now();
    if (this.cachedPricing && now - this.cachedAt < this.ttlMs) {
      return this.cachedPricing;
    }

    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = this.fetchPricingDisplay();

    try {
      const pricing = await this.inFlight;
      this.cachedPricing = pricing;
      this.cachedAt = Date.now();
      return pricing;
    } catch (error) {
      if (this.cachedPricing) {
        console.warn(
          '[api-gateway] ride pricing display refresh failed, using cached NGN rate:',
          error instanceof Error ? error.message : error,
        );
        return this.cachedPricing;
      }

      console.warn(
        '[api-gateway] ride pricing display refresh failed, using fallback NGN rate:',
        error instanceof Error ? error.message : error,
      );

      const fallbackPricing = createRidePricingDisplay(this.fallbackNgnPerUsdt);
      this.cachedPricing = fallbackPricing;
      this.cachedAt = Date.now();
      return fallbackPricing;
    } finally {
      this.inFlight = null;
    }
  }

  private async fetchPricingDisplay(): Promise<RidePricingDisplay> {
    const response = await fetch(new URL(COINGECKO_TETHER_PRICE_PATH, this.baseUrl), {
      headers: {
        accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`CoinGecko pricing request failed with status ${response.status}`);
    }

    const payload: unknown = await response.json();
    const ngnPerUsdt = extractNgnPerUsdt(payload);
    return createRidePricingDisplay(ngnPerUsdt);
  }
}

export function createRidePricingDisplay(ngnPerUsdt: number): RidePricingDisplay {
  const normalized = Number.isFinite(ngnPerUsdt) && ngnPerUsdt > 0 ? ngnPerUsdt : 1;
  return {
    displayCurrency: DEFAULT_RIDE_DISPLAY_CURRENCY,
    displayExchangeRate: round2(normalized),
  };
}

export function convertUsdtToRideDisplayAmount(
  amountUsdt: number | null | undefined,
  pricing: RidePricingDisplay,
): number | null {
  if (amountUsdt === null || amountUsdt === undefined || !Number.isFinite(amountUsdt)) {
    return null;
  }

  return round2(amountUsdt * pricing.displayExchangeRate);
}

export function withRideDisplayPricing<T extends Record<string, unknown>>(
  payload: T,
  pricing: RidePricingDisplay,
): T & RidePricingDisplay {
  return {
    ...payload,
    displayCurrency: pricing.displayCurrency,
    displayExchangeRate: pricing.displayExchangeRate,
  };
}

function extractNgnPerUsdt(payload: unknown): number {
  if (!payload || typeof payload !== 'object') {
    throw new Error('CoinGecko returned an invalid pricing payload');
  }

  const tether = (payload as { tether?: unknown }).tether;
  if (!tether || typeof tether !== 'object') {
    throw new Error('CoinGecko payload is missing tether pricing');
  }

  const ngn = (tether as { ngn?: unknown }).ngn;
  if (typeof ngn !== 'number' || !Number.isFinite(ngn) || ngn <= 0) {
    throw new Error('CoinGecko payload is missing a valid NGN price');
  }

  return ngn;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
