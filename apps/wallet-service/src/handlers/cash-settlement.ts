import { userClient, virtualAccountClient } from '@wheleers/db';
import { classifyPouchPayoutStatus } from '@wheleers/pouch-client';
import type { PouchLiquifiaClient } from '@wheleers/pouch-client';

const TAG = '[cash-settlement]';

/**
 * Move the driver's cut as REAL money: after the ledger settles a wallet
 * ride, pay the driver's share out of the rider's Pouch virtual account into
 * the driver's own virtual account (auto-provisioned when missing). From then
 * on the driver withdraws from an account that actually holds their earnings
 * — no treasury, no ledger-only money. Pouch's flat payout fee applies to
 * the transfer, per the platform's accepted cost model.
 *
 * Never throws: the ledger settlement already happened, so a cash-move
 * failure is logged as CRITICAL for reconciliation rather than crashing the
 * consumer.
 */
export function createCashSettlement(pouchClient: PouchLiquifiaClient | null) {
  // bank name → uuid, resolved once per process
  let bankUuidCache: Map<string, string> | null = null;

  async function resolveBankUuid(bankName: string): Promise<string | null> {
    if (!pouchClient) return null;
    if (!bankUuidCache) {
      try {
        const banks = await pouchClient.listBanks();
        bankUuidCache = new Map(
          banks
            .filter((b) => typeof b.name === 'string' && b.uuid)
            .map((b) => [b.name.toLowerCase(), b.uuid]),
        );
      } catch (error) {
        console.error(`${TAG} could not load bank list`, {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    }
    const target = bankName.toLowerCase();
    for (const [name, uuid] of bankUuidCache) {
      if (name === target || name.includes(target) || target.includes(name)) return uuid;
    }
    return null;
  }

  async function ensureDriverVirtualAccount(driverUserId: string) {
    const existing = await virtualAccountClient.findByUserId(driverUserId);
    if (existing) return existing;
    if (!pouchClient) return null;

    // Mirror of the gateway's provisioning flow.
    const user = await userClient.findById(driverUserId).catch(() => null);
    if (!user) return null;
    const nameParts = (user.name ?? 'Wheelers Driver').trim().split(/\s+/);

    let pouchCustomerId = user.pouchCustomerId;
    if (!pouchCustomerId) {
      const customer = await pouchClient.createCustomer({
        customerReference: driverUserId,
        firstName: nameParts[0] ?? 'Wheelers',
        lastName: nameParts.slice(1).join(' ') || 'Driver',
      });
      pouchCustomerId = customer.id;
      await userClient.updatePouchCustomerId(driverUserId, pouchCustomerId);
    }

    const va = await pouchClient.createVirtualAccount(pouchCustomerId, {
      country: 'NG',
      currency: 'NGN',
      idempotencyKey: `va-provision-${driverUserId}`,
    });

    try {
      return await virtualAccountClient.create({
        userId: driverUserId,
        pouchCustomerId,
        pouchVirtualAccountId: va.id,
        bankName: va.bank_name,
        accountNumber: va.account_number,
        accountName: va.account_name,
        currency: va.currency,
        country: va.country,
      });
    } catch {
      // provisioning race — another writer saved it
      return virtualAccountClient.findByUserId(driverUserId);
    }
  }

  return async function settleRideCashToDriver(params: {
    rideId: string;
    riderId: string;
    driverUserId: string;
    driverPayoutNgn: number;
  }): Promise<void> {
    const { rideId, riderId, driverUserId, driverPayoutNgn } = params;
    if (!pouchClient) {
      console.warn(`${TAG} POUCH_LIQUIFIA_API_KEY not configured — cash stays in rider VA`, { rideId });
      return;
    }
    if (driverPayoutNgn <= 0) return;

    try {
      const riderVa = await virtualAccountClient.findByUserId(riderId);
      if (!riderVa) {
        console.error(`${TAG} CRITICAL: rider has no virtual account — driver's cash not moved`, {
          rideId, riderId, driverUserId, driverPayoutNgn,
        });
        return;
      }

      const driverVa = await ensureDriverVirtualAccount(driverUserId);
      if (!driverVa) {
        console.error(`${TAG} CRITICAL: could not resolve/provision driver's virtual account — cash not moved`, {
          rideId, driverUserId, driverPayoutNgn,
        });
        return;
      }

      const bankUuid = await resolveBankUuid(driverVa.bankName);
      if (!bankUuid) {
        console.error(`${TAG} CRITICAL: no bank uuid for "${driverVa.bankName}" — cash not moved`, {
          rideId, driverUserId,
        });
        return;
      }

      const payout = await pouchClient.createPayout({
        virtualAccountId: riderVa.pouchVirtualAccountId,
        reference: `ride-cash-${rideId}`,
        amount: Math.floor(driverPayoutNgn),
        destinationAccount: driverVa.accountNumber,
        destinationBankUuid: bankUuid,
        narration: `Wheelers ride earnings ${rideId}`,
        // Idempotent per ride — a replayed RIDE_COMPLETED cannot pay twice.
        idempotencyKey: `ride-cash-${rideId}`,
      });

      const outcome = classifyPouchPayoutStatus(payout.status);
      if (outcome === 'failed') {
        console.error(`${TAG} CRITICAL: cash transfer to driver REJECTED — ledger settled but cash not moved`, {
          rideId, driverUserId, driverPayoutNgn, providerStatus: payout.status,
        });
        return;
      }

      console.info(`${TAG} driver's cut moved rider VA → driver VA`, {
        rideId,
        driverUserId,
        amountNgn: Math.floor(driverPayoutNgn),
        payoutId: payout.id,
        status: payout.status,
      });
    } catch (error) {
      console.error(`${TAG} CRITICAL: cash settlement failed — ledger settled but cash not moved`, {
        rideId,
        driverUserId,
        driverPayoutNgn,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
