import type { IncomingMessage, ServerResponse } from "http";
import {
  walletClient,
  withdrawalClient,
  virtualAccountClient,
  userClient,
} from "@wheleers/db";
import { authenticateHttpUser } from "./authenticate";
import { runIdempotentJsonRequest } from "./idempotency";
import { readJsonBody, sendJson } from "./utils";
import { isRecord, pickNumber, pickString } from "../utils/object";
import type { GatewayPublisher } from "../websocket/publisher";
import {
  PouchLiquifiaClient,
  type PouchBankAccount,
  type PouchPayout,
} from "@wheleers/pouch-client";
import type { RedisClient } from "../redis/client";
import type { PayoutCreatedEvent } from "@wheleers/kafka-schemas";

// ─── Deps ──────────────────────────────────────────────────────────

interface WalletRouteDeps {
  jwtSecret: string;
  publisher: GatewayPublisher;
  pouchLiquifiaClient: PouchLiquifiaClient;
  redisClient?: RedisClient;
}

// ─── Constants ─────────────────────────────────────────────────────

const BANK_NETWORKS_CACHE_TTL_SECONDS = 6 * 60 * 60;

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

// ─── Helpers ───────────────────────────────────────────────────────

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

// ─── Bank network helpers ──────────────────────────────────────────

function getBankCacheKey(country: string): string {
  return `pouch-liquifia:banks:${country.toUpperCase()}`;
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

function dedupeBanks(banks: PouchBankAccount[]): PouchBankAccount[] {
  const seen = new Set<string>();
  const deduped: PouchBankAccount[] = [];

  for (const bank of banks) {
    const name = typeof bank.name === "string" ? normalizeBankTerm(bank.name) : "";
    const code = typeof bank.code === "string" ? normalizeBankTerm(bank.code) : "";
    const key = `${name}|${code}`;
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(bank);
  }

  return deduped;
}

function getPreferredBankPriority(bank: PouchBankAccount): number {
  const name = typeof bank.name === "string" ? normalizeBankTerm(bank.name) : "";
  if (!name) {
    return Number.MAX_SAFE_INTEGER;
  }

  const index = PREFERRED_BANK_TERMS.findIndex((term) => name.includes(term));
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function scoreBankMatch(bank: PouchBankAccount, query: string): number {
  const name = typeof bank.name === "string" ? normalizeBankTerm(bank.name) : "";
  const code = typeof bank.code === "string" ? normalizeBankTerm(bank.code) : "";
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

function sortBanks(banks: PouchBankAccount[], query: string): PouchBankAccount[] {
  const normalizedQuery = query.trim();

  return [...banks].sort((left, right) => {
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

async function getBanksFromCacheOrProvider(
  deps: WalletRouteDeps,
  country: string,
  currency: string,
): Promise<PouchBankAccount[]> {
  const cacheKey = getBankCacheKey(country);

  if (deps.redisClient) {
    const cached = await deps.redisClient.get(cacheKey).catch(() => null);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as { banks?: PouchBankAccount[] };
        if (Array.isArray(parsed.banks)) {
          console.log("[api-gateway][wallet] bank cache hit", {
            country,
            cacheKey,
            count: parsed.banks.length,
          });
          return parsed.banks;
        }
      } catch {
        // ignore bad cache payload and fall through to provider
      }
    }
  }

  const banks = dedupeBanks(
    await deps.pouchLiquifiaClient.listBanks(country, currency),
  );

  console.log("[api-gateway][wallet] bank cache miss", {
    country,
    cacheKey,
    count: banks.length,
  });

  if (deps.redisClient) {
    await deps.redisClient
      .set(
        cacheKey,
        JSON.stringify({ banks }),
        BANK_NETWORKS_CACHE_TTL_SECONDS,
      )
      .catch(() => undefined);
  }

  return banks;
}

// ─── Mapping helpers ───────────────────────────────────────────────

function mapBankAccount(bank: PouchBankAccount) {
  return {
    uuid: typeof bank.uuid === "string" ? bank.uuid : "",
    name: typeof bank.name === "string" ? bank.name : "",
    code: typeof bank.code === "string" ? bank.code : null,
    country: typeof bank.country === "string" ? bank.country : null,
    currency: typeof bank.currency === "string" ? bank.currency : null,
    provider: typeof bank.provider === "string" ? bank.provider : null,
  };
}

function mapWithdrawalRequest(
  request: {
    id: string;
    status: string;
    requestedAmountNgn: unknown;
    reservedAmountNgn?: unknown;
    bankAccountNumber: string;
    bankAccountName: string;
    bankNetworkId: string;
    providerReference: string | null;
    failureReason: string | null;
    createdAt: Date;
    updatedAt: Date;
    settledAt?: Date | null;
    failedAt?: Date | null;
  },
) {
  return {
    id: request.id,
    status: request.status,
    amountNgn: decimalToNumber(request.requestedAmountNgn) ?? 0,
    bankAccount: {
      accountNumber: request.bankAccountNumber,
      accountName: request.bankAccountName,
      networkId: request.bankNetworkId,
    },
    providerReference: request.providerReference,
    failureReason: request.failureReason,
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
    settledAt: request.settledAt?.toISOString() ?? null,
    failedAt: request.failedAt?.toISOString() ?? null,
  };
}

// ─── Payout status sync ────────────────────────────────────────────

async function syncPayoutStatus(
  deps: WalletRouteDeps,
  pouchPayoutId: string,
  providerReference: string,
): Promise<PouchPayout> {
  const payout = await deps.pouchLiquifiaClient.getPayout(pouchPayoutId);
  const status = (payout.status ?? "").toUpperCase();

  if (status === "SUCCESSFUL" || status === "COMPLETED") {
    await withdrawalClient.settle(providerReference);
  } else if (
    status === "FAILED" ||
    status === "REVERSED" ||
    status === "CANCELLED"
  ) {
    await withdrawalClient.releaseFailedRequest({
      providerReference,
      failureReason: `Payout ${status.toLowerCase()}`,
      status: "FAILED",
    });
  } else if (status === "PROCESSING" || status === "PENDING") {
    await withdrawalClient.markProcessing(providerReference);
  }

  return payout;
}

// ─── Route handlers ────────────────────────────────────────────────

export async function handleWalletOverviewRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WalletRouteDeps,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const wallet = await walletClient.findByUserId(user.id);

    if (!wallet) {
      sendJson(res, 200, {
        walletId: null,
        balanceNgn: 0,
        lockedNgn: 0,
        updatedAt: new Date().toISOString(),
      });
      return;
    }

    const balanceNgn = decimalToNumber(wallet.balanceNgn) ?? 0;
    const lockedNgn = decimalToNumber(wallet.lockedNgn) ?? 0;

    sendJson(res, 200, {
      walletId: wallet.id,
      balanceNgn,
      lockedNgn,
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
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const wallet = await walletClient.findByUserId(user.id);

    if (!wallet) {
      sendJson(res, 200, { items: [], nextCursor: null });
      return;
    }

    const limit = parseLimit(url.searchParams.get("limit"));
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const transactions = await walletClient.findTransactions(wallet.id, limit, cursor);

    sendJson(res, 200, {
      items: transactions.map((transaction) => ({
        id: transaction.id,
        type: transaction.type,
        direction: transaction.direction,
        amountNgn: decimalToNumber(transaction.amountNgn) ?? 0,
        balanceAfterNgn: decimalToNumber(transaction.balanceAfterNgn) ?? 0,
        referenceId: transaction.referenceId,
        metadata: transaction.metadata ?? null,
        createdAt: transaction.createdAt.toISOString(),
      })),
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

export async function handleCreateWalletWithdrawalRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WalletRouteDeps,
): Promise<void> {
  let reservedRequestId: string | undefined;

  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: "Body must be a JSON object" });
      return;
    }

    const wallet = await walletClient.findByUserId(user.id);

    if (!wallet) {
      sendJson(res, 400, { error: "No wallet found. Fund your account first." });
      return;
    }

    // Parse amount
    const amountNgn = pickNumber(rawBody, ["amountNgn", "amountLocal", "amount"]);
    if (!amountNgn || amountNgn <= 0) {
      sendJson(res, 400, { error: "amountNgn must be a positive number." });
      return;
    }

    const requestedAmountNgn = roundNgn(amountNgn);

    // Check balance
    const balanceNgn = decimalToNumber(wallet.balanceNgn) ?? 0;
    if (balanceNgn < requestedAmountNgn) {
      sendJson(res, 400, {
        error: "Insufficient balance for this withdrawal.",
        availableBalanceNgn: roundNgn(balanceNgn),
        requestedAmountNgn,
      });
      return;
    }

    // Parse bank account
    const bankAccountBody = isRecord(rawBody["bankAccount"])
      ? rawBody["bankAccount"]
      : null;
    if (!bankAccountBody) {
      sendJson(res, 400, { error: "bankAccount is required." });
      return;
    }

    const accountNumber = pickString(bankAccountBody, ["accountNumber"]);
    const accountName = pickString(bankAccountBody, ["accountName"]);
    const bankUuid = pickString(bankAccountBody, ["bankUuid", "networkId"]);

    if (!accountNumber || !accountName || !bankUuid) {
      sendJson(res, 400, {
        error:
          "bankAccount.accountNumber, accountName, and bankUuid are required.",
      });
      return;
    }

    // Look up user's virtual account for the payout source
    const virtualAccount = await virtualAccountClient.findByUserId(user.id);
    if (!virtualAccount) {
      sendJson(res, 400, {
        error: "No virtual account found. Please set up deposits first.",
      });
      return;
    }

    const result = await runIdempotentJsonRequest({
      req,
      redisClient: deps.redisClient!,
      userId: user.id,
      routeKey: "wallet:withdrawals:create",
      requestBody: rawBody,
      execute: async () => {
        // Reserve funds on the wallet
        const reserveResult = await withdrawalClient.reserve({
          userId: user.id,
          walletId: wallet.id,
          amountNgn: requestedAmountNgn,
          bankAccountNumber: accountNumber,
          bankAccountName: accountName,
          bankNetworkId: bankUuid,
        });
        reservedRequestId = reserveResult.request.id;

        // Create payout via Pouch Liquifia
        const payout = await deps.pouchLiquifiaClient.createPayout({
          virtualAccountId: virtualAccount.pouchVirtualAccountId,
          reference: reserveResult.request.id,
          amount: requestedAmountNgn,
          destinationAccount: accountNumber,
          destinationBankUuid: bankUuid,
        });

        // Attach the payout to the withdrawal request
        await withdrawalClient.attachPayout({
          withdrawalRequestId: reserveResult.request.id,
          pouchPayoutId: payout.id,
          providerReference: payout.reference,
        });

        // Publish PAYOUT_CREATED event for payment-service to track lifecycle
        const payoutCreatedEvent: PayoutCreatedEvent = {
          eventType: 'PAYOUT_CREATED',
          userId: user.id,
          pouchPayoutId: payout.id,
          withdrawalId: reserveResult.request.id,
          amountNgn: requestedAmountNgn,
          bankAccountNumber: accountNumber,
          bankAccountName: accountName,
          bankNetworkId: bankUuid,
          timestamp: new Date().toISOString(),
        };
        await deps.publisher.publishPaymentEvent(payoutCreatedEvent);

        console.log("[api-gateway][wallet-withdrawal] payout created", {
          withdrawalRequestId: reserveResult.request.id,
          pouchPayoutId: payout.id,
          providerReference: payout.reference,
          amountNgn: requestedAmountNgn,
        });

        const createdRequest = await withdrawalClient.findById(
          reserveResult.request.id,
        );

        return {
          statusCode: 200,
          body: {
            withdrawal: createdRequest
              ? mapWithdrawalRequest(createdRequest)
              : null,
          },
        };
      },
    });

    sendJson(res, result.statusCode, result.body);
  } catch (error) {
    if (reservedRequestId) {
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
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const limit = parseLimit(url.searchParams.get("limit"));
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const items = await withdrawalClient.listByUser(user.id, limit, cursor);

    sendJson(res, 200, {
      items: items.map(mapWithdrawalRequest),
      nextCursor:
        items.length === limit ? (items[items.length - 1]?.id ?? null) : null,
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
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const request = await withdrawalClient.findById(withdrawalRequestId);

    if (!request || request.userId !== user.id) {
      sendJson(res, 404, { error: "Withdrawal not found." });
      return;
    }

    // If a payout was attached, check its latest status from the provider
    if (request.pouchPayoutId && request.providerReference) {
      await syncPayoutStatus(
        deps,
        request.pouchPayoutId,
        request.providerReference,
      );
    }

    const latestRequest = await withdrawalClient.findById(withdrawalRequestId);
    sendJson(res, 200, {
      withdrawal: latestRequest ? mapWithdrawalRequest(latestRequest) : null,
    });
  } catch (error) {
    sendJson(res, 400, {
      error:
        error instanceof Error
          ? error.message
          : "Could not load wallet withdrawal.",
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
    await authenticateHttpUser(req, deps.jwtSecret);

    const country = parseCountryCode(url.searchParams.get("country"), "NG");
    const currency = url.searchParams.get("currency")?.toUpperCase() ?? "NGN";
    const query = url.searchParams.get("query")?.trim().toLowerCase() ?? "";
    const limit = parseLimit(url.searchParams.get("limit"));

    const banks = await getBanksFromCacheOrProvider(deps, country, currency);
    const needles = getBankSearchNeedles(query);
    const filtered = query
      ? banks.filter(
          (bank) => scoreBankMatch(bank, query) !== Number.MAX_SAFE_INTEGER,
        )
      : banks;
    const ranked = sortBanks(filtered, query);

    console.log("[api-gateway][wallet] bank search", {
      country,
      currency,
      query,
      total: banks.length,
      matched: filtered.length,
      limit,
      needles,
    });

    sendJson(res, 200, {
      country,
      items: ranked
        .slice(0, limit)
        .map(mapBankAccount)
        .filter((item) => item.uuid && item.name),
    });
  } catch (error) {
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
    await authenticateHttpUser(req, deps.jwtSecret);
    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: "Body must be a JSON object" });
      return;
    }

    const accountNumber = pickString(rawBody, ["accountNumber"])?.replace(
      /\D/g,
      "",
    );
    const bankUuid = pickString(rawBody, ["bankUuid", "networkId"]);

    if (!accountNumber || !bankUuid) {
      sendJson(res, 400, {
        error: "accountNumber and bankUuid are required.",
      });
      return;
    }

    const verified = await deps.pouchLiquifiaClient.validateBankAccount({
      accountNumber,
      bankUuid,
    });

    sendJson(res, 200, {
      bankAccount: {
        accountNumber:
          typeof verified.account_number === "string"
            ? verified.account_number
            : accountNumber,
        accountName:
          typeof verified.account_name === "string"
            ? verified.account_name
            : null,
        bankName:
          typeof verified.bank_name === "string" ? verified.bank_name : null,
        bankUuid,
      },
    });
  } catch (error) {
    sendJson(res, 400, {
      error:
        error instanceof Error
          ? error.message
          : "Could not verify withdrawal bank account.",
    });
  }
}

export async function handleWalletDepositInfoRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WalletRouteDeps,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const virtualAccount = await virtualAccountClient.findByUserId(user.id);

    if (!virtualAccount) {
      sendJson(res, 404, {
        error: "No virtual account found. Please complete onboarding first.",
      });
      return;
    }

    sendJson(res, 200, {
      accountNumber: virtualAccount.accountNumber,
      accountName: virtualAccount.accountName,
      bankName: virtualAccount.bankName,
      currency: virtualAccount.currency,
    });
  } catch (error) {
    sendJson(res, 401, {
      error:
        error instanceof Error
          ? error.message
          : "Could not load deposit information.",
    });
  }
}

export async function handleProvisionVirtualAccountRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WalletRouteDeps,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);

    // Check if virtual account already exists
    const existing = await virtualAccountClient.findByUserId(user.id);
    if (existing) {
      sendJson(res, 200, {
        accountNumber: existing.accountNumber,
        accountName: existing.accountName,
        bankName: existing.bankName,
        currency: existing.currency,
        alreadyProvisioned: true,
      });
      return;
    }

    // Ensure wallet exists
    const wallet = await walletClient.findByUserId(user.id);
    if (!wallet) {
      await walletClient.create(user.id);
    }

    // Fetch full user for name
    const fullUser = await userClient.findById(user.id);
    const nameParts = (fullUser?.name ?? "Wheelers User").trim().split(/\s+/);
    const firstName = nameParts[0] ?? "Wheelers";
    const lastName = nameParts.slice(1).join(" ") || "User";

    // Create or retrieve Pouch customer
    let pouchCustomerId = fullUser?.pouchCustomerId;
    if (!pouchCustomerId) {
      const customer = await deps.pouchLiquifiaClient.createCustomer({
        customerReference: user.id,
        firstName,
        lastName,
      });
      pouchCustomerId = customer.id;
      await userClient.updatePouchCustomerId(user.id, pouchCustomerId);
    }

    // Create virtual account
    const va = await deps.pouchLiquifiaClient.createVirtualAccount(
      pouchCustomerId,
      { country: "NG", currency: "NGN" },
    );

    const created = await virtualAccountClient.create({
      userId: user.id,
      pouchCustomerId,
      pouchVirtualAccountId: va.id,
      bankName: va.bank_name,
      accountNumber: va.account_number,
      accountName: va.account_name,
      currency: va.currency,
      country: va.country,
    });

    sendJson(res, 201, {
      accountNumber: created.accountNumber,
      accountName: created.accountName,
      bankName: created.bankName,
      currency: created.currency,
      alreadyProvisioned: false,
    });
  } catch (error) {
    sendJson(res, 400, {
      error:
        error instanceof Error
          ? error.message
          : "Could not provision virtual account.",
    });
  }
}
