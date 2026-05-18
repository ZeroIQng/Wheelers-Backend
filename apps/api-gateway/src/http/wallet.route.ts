import type { IncomingMessage, ServerResponse } from "http";
import { sendTreasuryStellarUsdcPayment } from "@wheleers/blockchain";
import { paymentClient, walletClient, withdrawalClient } from "@wheleers/db";
import { hydrateProcessEnvWithStellarMasterWalletSecret } from "../treasury/master-wallet-secret";
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
  type PouchBankNetwork,
  PouchClient,
  type PouchOfframpPayload,
  type PouchRampStatusResponse,
} from "./pouch.client";
import type { RedisClient } from "../redis/client";

interface WalletRouteDeps {
  privyAppId: string;
  privyVerificationKey: string;
  ridePricingDisplayProvider: RidePricingDisplayProvider;
  pouchClient: PouchClient;
  publisher: GatewayPublisher;
  redisClient?: RedisClient;
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

const POUCH_BANK_NETWORKS_CACHE_TTL_SECONDS = 6 * 60 * 60;
const PREFERRED_BANK_TERMS = [
  "opay",
  "palmpay",
  "moniepoint",
  "access bank",
  "guaranty trust bank",
  "gtbank",
  "gt bank",
  "first bank of nigeria",
  "first city monument bank",
  "fcmb",
  "united bank for africa",
  "uba",
  "zenith bank",
  "wema bank",
  "sterling bank",
  "fidelity bank",
  "union bank of nigeria",
  "ecobank nigeria",
  "stanbic ibtc bank",
  "providus bank",
  "keystone bank",
  "polaris bank",
  "premiumtrust bank",
  "premium trust bank",
  "kuda",
  "paga",
  "jaiz bank",
  "taj bank",
];
const BANK_SEARCH_ALIASES: Record<string, string[]> = {
  opay: ["opay"],
  palmpay: ["palmpay"],
  moniepoint: ["moniepoint"],
  access: ["access bank", "access bank diamond", "access money", "accessmobile"],
  gtbank: ["gtbank", "gt bank", "guaranty trust bank", "gtmobile"],
  gt: ["gtbank", "gt bank", "guaranty trust bank", "gtmobile"],
  uba: ["uba", "united bank for africa"],
  firstbank: ["first bank", "first bank of nigeria", "fbnmobile"],
  first: ["first bank", "first bank of nigeria", "fbnmobile"],
  fcmb: ["fcmb", "first city monument bank", "fcmb easy account"],
  zenith: ["zenith bank", "zenithmobile"],
  sterling: ["sterling bank", "sterling mobile"],
  stanbic: ["stanbic ibtc bank", "stanbic ibtc ease wallet", "stanbic mobile money"],
  ecobank: ["ecobank nigeria", "ecobank xpress account", "ecomobile"],
  fidelity: ["fidelity bank", "fidelity mobile"],
  union: ["union bank of nigeria"],
  kuda: ["kuda microfinance bank", "kuda"],
  paga: ["paga"],
};

function getPouchBankNetworksCacheKey(country: string): string {
  return `pouch:bank-networks:${country.toUpperCase()}`;
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

function parseCountryCode(value: string | null | undefined, fallback: string): string {
  const normalized = value?.trim().toUpperCase();
  return normalized && normalized.length >= 2 ? normalized : fallback;
}

function normalizeBankTerm(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function getBankSearchNeedles(query: string): string[] {
  const normalized = normalizeBankTerm(query);
  if (!normalized) {
    return [];
  }

  const compact = normalized.replace(/\s+/g, "");
  const aliases = new Set<string>([normalized, compact]);

  for (const [key, values] of Object.entries(BANK_SEARCH_ALIASES)) {
    if (normalized === key || compact === key.replace(/\s+/g, "")) {
      for (const value of values) {
        aliases.add(normalizeBankTerm(value));
      }
    }
  }

  return [...aliases];
}

function dedupeBankNetworks(networks: PouchBankNetwork[]): PouchBankNetwork[] {
  const seen = new Set<string>();
  const deduped: PouchBankNetwork[] = [];

  for (const network of networks) {
    const name = typeof network.name === "string" ? normalizeBankTerm(network.name) : "";
    const code = typeof network.code === "string" ? normalizeBankTerm(network.code) : "";
    const key = `${name}|${code}`;
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(network);
  }

  return deduped;
}

function getPreferredBankPriority(network: PouchBankNetwork): number {
  const name = typeof network.name === "string" ? normalizeBankTerm(network.name) : "";
  if (!name) {
    return Number.MAX_SAFE_INTEGER;
  }

  const index = PREFERRED_BANK_TERMS.findIndex((term) => name.includes(term));
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function scoreBankMatch(network: PouchBankNetwork, query: string): number {
  const name = typeof network.name === "string" ? normalizeBankTerm(network.name) : "";
  const code = typeof network.code === "string" ? normalizeBankTerm(network.code) : "";
  const needles = getBankSearchNeedles(query);

  if (!needles.length) {
    return 0;
  }

  let best = Number.MAX_SAFE_INTEGER;

  for (const needle of needles) {
    if (!needle) {
      continue;
    }

    if (name === needle || code === needle) {
      best = Math.min(best, 0);
      continue;
    }

    if (name.startsWith(needle) || code.startsWith(needle)) {
      best = Math.min(best, 1);
      continue;
    }

    if (name.includes(needle) || code.includes(needle)) {
      best = Math.min(best, 2);
    }
  }

  return best;
}

function sortBankNetworks(networks: PouchBankNetwork[], query: string): PouchBankNetwork[] {
  const normalizedQuery = query.trim();

  return [...networks].sort((left, right) => {
    const leftName = typeof left.name === "string" ? left.name : "";
    const rightName = typeof right.name === "string" ? right.name : "";

    if (normalizedQuery) {
      const leftScore = scoreBankMatch(left, normalizedQuery);
      const rightScore = scoreBankMatch(right, normalizedQuery);
      if (leftScore !== rightScore) {
        return leftScore - rightScore;
      }
    } else {
      const leftPriority = getPreferredBankPriority(left);
      const rightPriority = getPreferredBankPriority(right);
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }
    }

    return leftName.localeCompare(rightName);
  });
}

async function ensureUserWallet(
  user: Awaited<ReturnType<typeof authenticateHttpUser>>,
) {
  if (user.wallet) {
    return user.wallet;
  }

  if (!user.walletAddress) {
    throw new Error("No linked wallet address found for this user.");
  }

  try {
    return await walletClient.create(user.id, user.walletAddress);
  } catch {
    return walletClient.findByUserId(user.id);
  }
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

function mapBankNetwork(network: PouchBankNetwork) {
  return {
    id: typeof network.id === "string" ? network.id : "",
    name: typeof network.name === "string" ? network.name : "",
    code: typeof network.code === "string" ? network.code : null,
    country: typeof network.country === "string" ? network.country : null,
    accountNumberType:
      typeof network.accountNumberType === "string"
        ? network.accountNumberType
        : null,
    type: typeof network.type === "string" ? network.type : null,
  };
}

async function getBankNetworksFromCacheOrProvider(
  deps: WalletRouteDeps,
  country: string,
): Promise<PouchBankNetwork[]> {
  const cacheKey = getPouchBankNetworksCacheKey(country);

  if (deps.redisClient) {
    const cached = await deps.redisClient.get(cacheKey).catch(() => null);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as { networks?: PouchBankNetwork[] };
        if (Array.isArray(parsed.networks)) {
          console.log("[api-gateway][wallet-withdrawal] bank cache hit", {
            country,
            cacheKey,
            count: parsed.networks.length,
            hasOpay: parsed.networks.some(
              (network) =>
                typeof network.name === "string" &&
                network.name.toLowerCase() === "opay",
            ),
          });
          return parsed.networks;
        }
      } catch {
        // ignore bad cache payload and fall through to provider
      }
    }
  }

  const response = await deps.pouchClient.getCryptoBankNetworks(country);
  const networks = dedupeBankNetworks(
    Array.isArray(response.networks) ? response.networks : [],
  );

  console.log("[api-gateway][wallet-withdrawal] bank cache miss", {
    country,
    cacheKey,
    count: networks.length,
    hasOpay: networks.some(
      (network) =>
        typeof network.name === "string" &&
        network.name.toLowerCase() === "opay",
    ),
  });

  if (deps.redisClient) {
    await deps.redisClient
      .set(
        cacheKey,
        JSON.stringify({ networks }),
        POUCH_BANK_NETWORKS_CACHE_TTL_SECONDS,
      )
      .catch(() => undefined);
  }

  return networks;
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
    const wallet = await ensureUserWallet(user);
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

export async function handleListWithdrawalBankNetworksRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WalletRouteDeps,
  url: URL,
): Promise<void> {
  try {
    await authenticateHttpUser(req, deps.privyAppId, deps.privyVerificationKey);
    const country = parseCountryCode(
      url.searchParams.get("country"),
      deps.defaults.countryCode,
    );
    const query = url.searchParams.get("query")?.trim().toLowerCase() ?? "";
    const limit = parseLimit(url.searchParams.get("limit"));
    const networks = await getBankNetworksFromCacheOrProvider(deps, country);
    const needles = getBankSearchNeedles(query);
    const filtered = query
      ? networks.filter((network) => scoreBankMatch(network, query) !== Number.MAX_SAFE_INTEGER)
      : networks;
    const ranked = sortBankNetworks(filtered, query);

    console.log("[api-gateway][wallet-withdrawal] bank search", {
      country,
      query,
      total: networks.length,
      matched: filtered.length,
      limit,
      needles,
      includesOpay:
        filtered.find(
          (network) =>
            typeof network.name === "string" &&
            network.name.toLowerCase() === "opay",
        ) != null,
    });

    sendJson(res, 200, {
      country,
      items: ranked
        .slice(0, limit)
        .map(mapBankNetwork)
        .filter((item) => item.id && item.name),
    });
  } catch (error) {
    if (error instanceof PouchApiError) {
      sendJson(res, error.statusCode, {
        error: "Could not load Pouch bank networks.",
        details: error.responseBody,
      });
      return;
    }

    sendJson(res, 401, {
      error:
        error instanceof Error
          ? error.message
          : "Could not load withdrawal bank networks.",
    });
  }
}

export async function handleVerifyWithdrawalBankAccountRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WalletRouteDeps,
): Promise<void> {
  try {
    await authenticateHttpUser(req, deps.privyAppId, deps.privyVerificationKey);
    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: "Body must be a JSON object" });
      return;
    }

    const accountNumber = pickString(rawBody, ["accountNumber"])?.replace(/\D/g, "");
    const networkId = pickString(rawBody, ["networkId"]);

    if (!accountNumber || !networkId) {
      sendJson(res, 400, {
        error: "accountNumber and networkId are required.",
      });
      return;
    }

    const countryCode =
      pickString(rawBody, ["countryCode"])?.toUpperCase() ?? deps.defaults.countryCode;
    const providerId = pickString(rawBody, ["providerId"]) ?? deps.defaults.providerId;

    const verified = await deps.pouchClient.verifySharedKycBankAccount({
      accountNumber,
      networkId,
      countryCode,
      providerId,
    });

    sendJson(res, 200, {
      bankAccount: {
        accountNumber:
          typeof verified.accountNumber === "string" ? verified.accountNumber : accountNumber,
        accountName:
          typeof verified.accountName === "string" ? verified.accountName : null,
        bankName: typeof verified.bankName === "string" ? verified.bankName : null,
        networkId,
      },
      verificationSessionId: null,
    });
  } catch (error) {
    if (error instanceof PouchApiError) {
      sendJson(res, error.statusCode, {
        error: "Could not verify the bank account.",
        details: error.responseBody,
      });
      return;
    }

    sendJson(res, 400, {
      error:
        error instanceof Error
          ? error.message
          : "Could not verify withdrawal bank account.",
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

    const wallet = await ensureUserWallet(user);
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

    await hydrateProcessEnvWithStellarMasterWalletSecret({
      AWS_REGION: process.env["AWS_REGION"],
      STELLAR_MASTER_WALLET_SECRET_NAME:
        process.env["STELLAR_MASTER_WALLET_SECRET_NAME"],
      STELLAR_SECRET_KEY: process.env["STELLAR_SECRET_KEY"],
      POUCH_MASTER_WALLET_ADDRESS: deps.defaults.masterWalletAddress,
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
    const wallet = await ensureUserWallet(user);
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
