import type { IncomingMessage, ServerResponse } from "http";
import { walletClient } from "@wheleers/db";
import { authenticateHttpUser } from "./authenticate";
import { sendJson } from "./utils";
import {
  convertUsdtToRideDisplayAmount,
  type RidePricingDisplayProvider,
} from "../pricing/display";

interface WalletRouteDeps {
  privyAppId: string;
  privyVerificationKey: string;
  ridePricingDisplayProvider: RidePricingDisplayProvider;
}

function parseLimit(value: string | null): number {
  if (!value) {
    return 20;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 20;
  }

  return Math.min(parsed, 50);
}

function decimalToNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (
    value &&
    typeof value === "object" &&
    "toNumber" in value &&
    typeof value.toNumber === "function"
  ) {
    const parsed = value.toNumber();
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

export async function handleWalletOverviewRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WalletRouteDeps,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(
      req,
      deps.privyAppId,
      deps.privyVerificationKey,
    );
    const wallet = await walletClient.findByUserId(user.id);
    const pricing = await deps.ridePricingDisplayProvider.getPricingDisplay();

    const balanceUsdt = decimalToNumber(wallet.balanceUsdt) ?? 0;
    const lockedUsdt = decimalToNumber(wallet.lockedUsdt) ?? 0;
    const stakedUsdt = decimalToNumber(wallet.stakedUsdt) ?? 0;

    sendJson(res, 200, {
      walletId: wallet.id,
      walletAddress: wallet.address,
      chain: wallet.chain,
      balanceUsdt,
      lockedUsdt,
      stakedUsdt,
      balanceNgn: convertUsdtToRideDisplayAmount(balanceUsdt, pricing) ?? 0,
      lockedNgn: convertUsdtToRideDisplayAmount(lockedUsdt, pricing) ?? 0,
      stakedNgn: convertUsdtToRideDisplayAmount(stakedUsdt, pricing) ?? 0,
      displayCurrency: pricing.displayCurrency,
      displayExchangeRate: pricing.displayExchangeRate,
      updatedAt: wallet.updatedAt.toISOString(),
    });
  } catch (error) {
    sendJson(res, 401, {
      error:
        error instanceof Error ? error.message : "Could not load wallet overview",
    });
  }
}

export async function handleWalletTransactionsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WalletRouteDeps,
  url: URL,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(
      req,
      deps.privyAppId,
      deps.privyVerificationKey,
    );
    const wallet = await walletClient.findByUserId(user.id);
    const limit = parseLimit(url.searchParams.get("limit"));
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const transactions = await walletClient.findTransactions(wallet.id, limit, cursor);
    const pricing = await deps.ridePricingDisplayProvider.getPricingDisplay();

    sendJson(res, 200, {
      items: transactions.map((transaction) => {
        const amountUsdt = decimalToNumber(transaction.amountUsdt) ?? 0;
        const balanceAfterUsdt = decimalToNumber(transaction.balanceAfter) ?? 0;

        return {
          id: transaction.id,
          type: transaction.type,
          direction: transaction.direction,
          amountUsdt,
          amountNgn: convertUsdtToRideDisplayAmount(amountUsdt, pricing) ?? 0,
          balanceAfterUsdt,
          balanceAfterNgn:
            convertUsdtToRideDisplayAmount(balanceAfterUsdt, pricing) ?? 0,
          referenceId: transaction.referenceId,
          metadata: transaction.metadata ?? null,
          createdAt: transaction.createdAt.toISOString(),
          displayCurrency: pricing.displayCurrency,
          displayExchangeRate: pricing.displayExchangeRate,
        };
      }),
      nextCursor:
        transactions.length === limit
          ? (transactions[transactions.length - 1]?.id ?? null)
          : null,
    });
  } catch (error) {
    sendJson(res, 401, {
      error:
        error instanceof Error
          ? error.message
          : "Could not load wallet transactions",
    });
  }
}
