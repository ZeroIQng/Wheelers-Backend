import type { IncomingMessage, ServerResponse } from "http";
import { sendTreasuryStellarUsdcPayment } from "@wheleers/blockchain";
import { paymentClient, walletClient, withdrawalClient } from "@wheleers/db";
import { authenticateHttpUser } from "./authenticate";
import { readJsonBody, sendJson } from "./utils";
import {
  convertUsdtToRideDisplayAmount,
  type RidePricingDisplayProvider,
} from "../pricing/display";
import { isRecord, pickNumber, pickString } from "../utils/object";
import type { GatewayPublisher } from "../websocket/publisher";
import {
  buildPaymentIntentUpsertFromEvent,
  buildPouchMetadata,
  deriveLifecycleStatus,
  normalizePouchTransactionCreated,
  normalizePouchTransactionStatus,
} from "./pouch.helpers";
import {
  PouchApiError,
  PouchClient,
  type PouchOfframpPayload,
  type PouchRampStatusResponse,
} from "./pouch.client";

interface WalletRouteDeps {
  privyAppId: string;
  privyVerificationKey: string;
  ridePricingDisplayProvider: RidePricingDisplayProvider;
  pouchClient: PouchClient;
  publisher: GatewayPublisher;
  defaults: {
    providerId: string;
    countryCode: string;
    currency: string;
    cryptoCurrency: string;
    cryptoNetwork: string;
    chain?: string;
    masterWalletAddress: string;
    stellarNetwork?: "mainnet" | "testnet";
    testEmail?: string;
    userKycDefaults?: Record<string, string>;
  };
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

function roundNgn(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundUsdt(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function mapWithdrawalRequest(
  request: {
    id: string;
    status: string;
    requestedAmountNgn: unknown;
    quotedAmountNgn: unknown;
    reservedAmountUsdt: unknown;
    quotedAmountUsd: unknown;
    quotedCryptoAmount: unknown;
    displayCurrency: string;
    displayExchangeRate: unknown;
    payoutCurrency: string;
    cryptoCurrency: string;
    cryptoNetwork: string;
    bankAccountNumber: string;
    bankAccountName: string;
    bankNetworkId: string;
    providerReference: string | null;
    paymentId: string | null;
    failureReason: string | null;
    expiresAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    settledAt?: Date | null;
    failedAt?: Date | null;
    releasedAt?: Date | null;
  },
) {
  return {
    id: request.id,
    status: request.status,
    requestedAmountNgn: decimalToNumber(request.requestedAmountNgn) ?? 0,
    quotedAmountNgn: decimalToNumber(request.quotedAmountNgn),
    reservedAmountUsdt: decimalToNumber(request.reservedAmountUsdt) ?? 0,
    quotedAmountUsd: decimalToNumber(request.quotedAmountUsd),
    quotedCryptoAmount: decimalToNumber(request.quotedCryptoAmount),
    displayCurrency: request.displayCurrency,
    displayExchangeRate: decimalToNumber(request.displayExchangeRate) ?? 0,
    payoutCurrency: request.payoutCurrency,
    cryptoCurrency: request.cryptoCurrency,
    cryptoNetwork: request.cryptoNetwork,
    bankAccount: {
      accountNumber: request.bankAccountNumber,
      accountName: request.bankAccountName,
      networkId: request.bankNetworkId,
    },
    providerReference: request.providerReference,
    paymentId: request.paymentId,
    failureReason: request.failureReason,
    expiresAt: request.expiresAt?.toISOString() ?? null,
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
    settledAt: request.settledAt?.toISOString() ?? null,
    failedAt: request.failedAt?.toISOString() ?? null,
    releasedAt: request.releasedAt?.toISOString() ?? null,
  };
}

function readUserKyc(
  value: unknown,
  defaults?: Record<string, string>,
): Record<string, unknown> | null {
  const mergedDefaults =
    defaults && Object.keys(defaults).length > 0 ? defaults : undefined;

  if (isRecord(value)) {
    const normalizedInput = normalizePouchUserKyc(value);
    return mergedDefaults
      ? {
          ...mergedDefaults,
          ...normalizedInput,
        }
      : normalizedInput;
  }

  return mergedDefaults ?? null;
}

function normalizePouchUserKyc(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => {
      const normalizedKey = normalizePouchUserKycKey(key);
      const normalizedValue =
        normalizedKey === "DOB" && typeof entryValue === "string"
          ? normalizePouchDob(entryValue)
          : entryValue;

      return [normalizedKey, normalizedValue];
    }),
  );
}

function normalizePouchUserKycKey(key: string): string {
  const compact = key.replace(/[\s-]+/g, "_");
  const upper = compact.toUpperCase();
  return upper === "FULLNAME" ? "FULL_NAME" : upper;
}

function normalizePouchDob(value: string): string {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }

  const slashMatch = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!slashMatch) {
    return trimmed;
  }

  const [, month, day, year] = slashMatch;
  return `${year}-${month}-${day}`;
}

function parseRequestedWithdrawalAmount(body: Record<string, unknown>): number {
  const amountNgn = pickNumber(body, ["amountNgn", "amountLocal", "amount"]);
  if (!amountNgn || amountNgn <= 0) {
    throw new Error("amountNgn must be a positive number.");
  }

  return roundNgn(amountNgn);
}

function buildWalletWithdrawalOfframpPayload(
  body: Record<string, unknown>,
  deps: WalletRouteDeps["defaults"],
  reservedAmountUsdt: number,
): PouchOfframpPayload {
  const bankAccount = isRecord(body["bankAccount"]) ? body["bankAccount"] : null;
  if (!bankAccount) {
    throw new Error("bankAccount is required.");
  }

  const accountNumber = pickString(bankAccount, ["accountNumber"]);
  const accountName = pickString(bankAccount, ["accountName"]);
  const networkId = pickString(bankAccount, ["networkId"]);

  if (!accountNumber || !accountName || !networkId) {
    throw new Error(
      "bankAccount.accountNumber, accountName, and networkId are required.",
    );
  }

  return {
    cryptoAmount: roundUsdt(reservedAmountUsdt),
    cryptoCurrency:
      pickString(body, ["cryptoCurrency"])?.toUpperCase() ?? deps.cryptoCurrency,
    cryptoNetwork:
      pickString(body, ["cryptoNetwork"])?.toUpperCase() ?? deps.cryptoNetwork,
    countryCode:
      pickString(body, ["countryCode"])?.toUpperCase() ?? deps.countryCode,
    currency: pickString(body, ["currency"])?.toUpperCase() ?? deps.currency,
    providerId: pickString(body, ["providerId"]) ?? deps.providerId,
    bankAccount: {
      accountNumber,
      accountName,
      networkId,
    },
    userKyc: readUserKyc(body["userKyc"], deps.userKycDefaults) ?? undefined,
  };
}

async function syncWithdrawalLifecycle(
  providerReference: string,
  statusResponse: PouchRampStatusResponse,
): Promise<void> {
  const lifecycleStatus = deriveLifecycleStatus(statusResponse.status ?? "");
  const failureReason =
    typeof statusResponse.failureReason === "string" &&
    statusResponse.failureReason.trim().length > 0
      ? statusResponse.failureReason
      : statusResponse.status ?? "Withdrawal failed";

  if (lifecycleStatus === "SETTLED") {
    await withdrawalClient.settle(providerReference);
    return;
  }

  if (
    lifecycleStatus === "FAILED" ||
    lifecycleStatus === "EXPIRED" ||
    lifecycleStatus === "CANCELLED"
  ) {
    await withdrawalClient.releaseFailedRequest({
      providerReference,
      failureReason,
      status: lifecycleStatus,
    });
    return;
  }

  await withdrawalClient.markProcessing(providerReference);
}

function maskWalletAddress(value: string): string {
  if (value.length <= 10) {
    return value;
  }

  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function maskTransactionHash(value: string): string {
  if (value.length <= 10) {
    return value;
  }

  return `${value.slice(0, 6)}...${value.slice(-4)}`;
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

export async function handleCreateWalletWithdrawalRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WalletRouteDeps,
): Promise<void> {
  let reservedRequestId: string | undefined;
  let treasurySubmitted = false;

  try {
    const user = await authenticateHttpUser(
      req,
      deps.privyAppId,
      deps.privyVerificationKey,
    );
    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: "Body must be a JSON object" });
      return;
    }

    const wallet = await walletClient.findByUserId(user.id);
    const pricing = await deps.ridePricingDisplayProvider.getPricingDisplay();
    const requestedAmountNgn = parseRequestedWithdrawalAmount(rawBody);
    const availableBalanceUsdt = decimalToNumber(wallet.balanceUsdt) ?? 0;
    const availableBalanceNgn =
      convertUsdtToRideDisplayAmount(availableBalanceUsdt, pricing) ?? 0;

    if (availableBalanceNgn < requestedAmountNgn) {
      sendJson(res, 400, {
        error: "Insufficient balance for this withdrawal.",
        availableBalanceNgn: roundNgn(availableBalanceNgn),
        requestedAmountNgn,
      });
      return;
    }

    const reservedAmountUsdt = roundUsdt(
      requestedAmountNgn / pricing.displayExchangeRate,
    );

    if (!Number.isFinite(reservedAmountUsdt) || reservedAmountUsdt <= 0) {
      sendJson(res, 400, { error: "Could not compute a withdrawal quote." });
      return;
    }

    const payload = buildWalletWithdrawalOfframpPayload(
      rawBody,
      deps.defaults,
      reservedAmountUsdt,
    );

    const reserveResult = await withdrawalClient.reserve({
      userId: user.id,
      walletId: wallet.id,
      requestedAmountNgn,
      reservedAmountUsdt,
      displayCurrency: pricing.displayCurrency,
      displayExchangeRate: pricing.displayExchangeRate,
      payoutCurrency: deps.defaults.currency,
      cryptoCurrency: payload.cryptoCurrency,
      cryptoNetwork: payload.cryptoNetwork,
      bankAccountNumber: payload.bankAccount.accountNumber,
      bankAccountName: payload.bankAccount.accountName,
      bankNetworkId: payload.bankAccount.networkId,
    });
    reservedRequestId = reserveResult.request.id;

    const response = await deps.pouchClient.createSharedKycOfframp(payload);
    const createdEvent = normalizePouchTransactionCreated({
      type: "OFFRAMP",
      payload: response,
      metadata: buildPouchMetadata({
        userId: user.id,
        walletAddress: wallet.address,
      }),
      chain: deps.defaults.chain,
      customerEmail: user.email ?? deps.defaults.testEmail,
    });

    if (!createdEvent) {
      throw new Error("Pouch offramp response could not be normalized.");
    }

    await paymentClient.upsertPaymentIntent(
      buildPaymentIntentUpsertFromEvent(createdEvent, response),
    );
    await withdrawalClient.attachOfframp({
      withdrawalRequestId: reserveResult.request.id,
      paymentId: createdEvent.paymentId,
      providerReference: createdEvent.providerReference,
      quotedAmountNgn:
        pickNumber(response, ["cryptoInstruction.amountLocal"]) ?? undefined,
      quotedAmountUsd:
        pickNumber(response, ["cryptoInstruction.amountUsd"]) ?? undefined,
      quotedCryptoAmount:
        pickNumber(response, ["cryptoInstruction.cryptoAmount"]) ??
        createdEvent.amountUsd,
      providerPayload: response,
      expiresAt:
        typeof response.cryptoInstruction?.expiresAt === "string"
          ? new Date(response.cryptoInstruction.expiresAt)
          : undefined,
    });
    await deps.publisher.publishPaymentEvent(createdEvent);

    const treasuryDestinationAddress =
      typeof response.cryptoInstruction?.walletAddress === "string"
        ? response.cryptoInstruction.walletAddress.trim()
        : "";
    const treasuryCryptoAmount =
      pickNumber(response, ["cryptoInstruction.cryptoAmount"]) ??
      createdEvent.amountUsd;

    if (!treasuryDestinationAddress) {
      throw new Error("Pouch offramp did not return a Stellar destination address.");
    }

    if (payload.cryptoCurrency !== "USDC" || payload.cryptoNetwork !== "XLM") {
      throw new Error(
        `Automated treasury payout only supports USDC on XLM right now. Received ${payload.cryptoCurrency} on ${payload.cryptoNetwork}.`,
      );
    }

    console.log("[api-gateway][wallet-withdrawal] sending treasury payout", {
      withdrawalRequestId: reserveResult.request.id,
      providerReference: createdEvent.providerReference,
      destinationAddress: maskWalletAddress(treasuryDestinationAddress),
      cryptoAmount: treasuryCryptoAmount,
      cryptoCurrency: payload.cryptoCurrency,
      cryptoNetwork: payload.cryptoNetwork,
      stellarNetwork: deps.defaults.stellarNetwork ?? "mainnet",
    });

    const treasurySendResult = await sendTreasuryStellarUsdcPayment({
      destinationAddress: treasuryDestinationAddress,
      amount: treasuryCryptoAmount,
      network: deps.defaults.stellarNetwork ?? "mainnet",
    });
    treasurySubmitted = true;

    await withdrawalClient.recordTreasurySubmission({
      withdrawalRequestId: reserveResult.request.id,
      transactionHash: treasurySendResult.hash,
      senderAddress: treasurySendResult.sourceAddress,
      destinationAddress: treasurySendResult.destinationAddress,
      amount: treasurySendResult.amount,
      assetCode: treasurySendResult.assetCode,
      assetIssuer: treasurySendResult.assetIssuer,
      network: treasurySendResult.network,
    });

    console.log("[api-gateway][wallet-withdrawal] treasury payout submitted", {
      withdrawalRequestId: reserveResult.request.id,
      providerReference: createdEvent.providerReference,
      transactionHash: maskTransactionHash(treasurySendResult.hash),
      senderAddress: maskWalletAddress(treasurySendResult.sourceAddress),
      destinationAddress: maskWalletAddress(treasurySendResult.destinationAddress),
      amount: treasurySendResult.amount,
      assetCode: treasurySendResult.assetCode,
    });

    const createdRequest = await withdrawalClient.findById(reserveResult.request.id);

    sendJson(res, 200, {
      withdrawal: createdRequest ? mapWithdrawalRequest(createdRequest) : null,
      provider: "pouch",
      type: "OFFRAMP",
      cryptoInstruction: response.cryptoInstruction,
    });
  } catch (error) {
    if (reservedRequestId && !treasurySubmitted) {
      await withdrawalClient
        .releaseFailedRequest({
          withdrawalRequestId: reservedRequestId,
          failureReason:
            error instanceof Error
              ? error.message
              : "Withdrawal creation failed.",
          status: "FAILED",
        })
        .catch(() => undefined);
    }

    if (error instanceof PouchApiError) {
      sendJson(res, error.statusCode, {
        error: "Failed to create withdrawal payout.",
        details: error.responseBody,
      });
      return;
    }

    sendJson(res, 400, {
      error:
        error instanceof Error
          ? error.message
          : "Could not create wallet withdrawal.",
    });
  }
}

export async function handleListWalletWithdrawalsRoute(
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
    const limit = parseLimit(url.searchParams.get("limit"));
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const items = await withdrawalClient.listByUser(user.id, limit, cursor);

    sendJson(res, 200, {
      items: items.map(mapWithdrawalRequest),
      nextCursor: items.length === limit ? (items[items.length - 1]?.id ?? null) : null,
    });
  } catch (error) {
    sendJson(res, 401, {
      error:
        error instanceof Error
          ? error.message
          : "Could not load wallet withdrawals",
    });
  }
}

export async function handleGetWalletWithdrawalRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WalletRouteDeps,
  withdrawalRequestId: string,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(
      req,
      deps.privyAppId,
      deps.privyVerificationKey,
    );
    const request = await withdrawalClient.findById(withdrawalRequestId);

    if (!request || request.userId !== user.id) {
      sendJson(res, 404, { error: "Withdrawal not found." });
      return;
    }

    if (request.providerReference) {
      const statusResponse = await deps.pouchClient.getRampStatus(
        request.providerReference,
        "OFFRAMP",
      );
      await syncWithdrawalLifecycle(request.providerReference, statusResponse);

      const syncedIntent = await paymentClient.findPaymentIntentByProviderReference(
        request.providerReference,
      );

      if (syncedIntent) {
        const syncedEvent = normalizePouchTransactionStatus({
          payload: statusResponse,
          intent: syncedIntent,
        });

        if (syncedEvent) {
          await paymentClient.upsertPaymentIntent(
            buildPaymentIntentUpsertFromEvent(syncedEvent, statusResponse),
          );
          await deps.publisher.publishPaymentEvent(syncedEvent);
        }
      }
    }

    const latestRequest = await withdrawalClient.findById(withdrawalRequestId);
    sendJson(res, 200, {
      withdrawal: latestRequest ? mapWithdrawalRequest(latestRequest) : null,
    });
  } catch (error) {
    if (error instanceof PouchApiError) {
      sendJson(res, error.statusCode, {
        error: "Could not refresh withdrawal status.",
        details: error.responseBody,
      });
      return;
    }

    sendJson(res, 400, {
      error:
        error instanceof Error
          ? error.message
          : "Could not load wallet withdrawal.",
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
