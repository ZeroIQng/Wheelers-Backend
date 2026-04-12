export interface NgnConversionResult {
  amountUsdt: number;
  exchangeRate: number;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function convertNgnToUsdt(amountNgn: number, exchangeRate: number): NgnConversionResult {
  if (!Number.isFinite(amountNgn) || amountNgn <= 0) {
    throw new Error('amountNgn must be a positive number');
  }

  if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) {
    throw new Error('exchangeRate must be a positive number');
  }

  return {
    amountUsdt: round6(amountNgn / exchangeRate),
    exchangeRate,
  };
}
