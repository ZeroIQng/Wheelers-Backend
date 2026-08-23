import { userClient, virtualAccountClient } from '@wheleers/db';
import { classifyPouchPayoutStatus } from '@wheleers/pouch-client';
import type { PouchLiquifiaClient } from '@wheleers/pouch-client';

const TAG = '[cash-escrow]';

/**
 * Real-money escrow around the ride lifecycle. The treasury's ONLY job is to
 * hold funds while a ride is in flight:
 *
 *   driver assigned  →  rider VA ──(total fare + fees)──► TREASURY
 *   ride completed   →  TREASURY ──(driver's cut)──────► driver VA
 *                       (platform fee REMAINS in treasury = revenue)
 *   ride cancelled   →  TREASURY ──(full escrow)───────► rider VA
 *
 * Everyone still withdraws from their OWN account — the treasury never backs
 * withdrawals. Without a configured treasury the module degrades to the
 * direct rider→driver transfer on completion (no in-flight custody).
 *
 * Every movement is idempotent per ride and never throws: ledger operations
 * have already happened, so cash failures log CRITICAL for reconciliation.
 */
export function createCashEscrow(
  pouchClient: PouchLiquifiaClient | null,
  treasuryVaId: string | null,
) {
  let bankUuidCache: Map<string, string> | null = null;
  let treasuryVaDetails: { accountNumber: string; bankName: string } | null = null;

  async function resolveBankUuid(bankName: string): Promise<string | null> {
    if (!pouchClient) return null;
    if (!bankUuidCache) {
      try {
        const banks = await pouchClient.listBanks();
        bankUuidCache = new Map(
          banks.filter((b) => typeof b.name === 'string' && b.uuid).map((b) => [b.name.toLowerCase(), b.uuid]),
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

  async function getTreasuryDetails() {
    if (!treasuryVaId || !pouchClient) return null;
    if (!treasuryVaDetails) {
      try {
        const va = await pouchClient.getVirtualAccount(treasuryVaId);
        treasuryVaDetails = { accountNumber: va.account_number, bankName: va.bank_name };
      } catch (error) {
        console.error(`${TAG} could not load treasury VA details`, {
          treasuryVaId,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    }
    return treasuryVaDetails;
  }

  /** One idempotent VA→account transfer; true on accepted, false otherwise. */
  async function transfer(params: {
    sourceVaId: string;
    destAccountNumber: string;
    destBankName: string;
    amountNgn: number;
    idempotencyKey: string;
    narration: string;
  }): Promise<boolean> {
    if (!pouchClient) return false;
    const bankUuid = await resolveBankUuid(params.destBankName);
    if (!bankUuid) {
      console.error(`${TAG} CRITICAL: no bank uuid for "${params.destBankName}" — transfer not made`, params);
      return false;
    }
    const payout = await pouchClient.createPayout({
      virtualAccountId: params.sourceVaId,
      reference: params.idempotencyKey,
      amount: Math.floor(params.amountNgn),
      destinationAccount: params.destAccountNumber,
      destinationBankUuid: bankUuid,
      narration: params.narration,
      idempotencyKey: params.idempotencyKey,
    });
    if (classifyPouchPayoutStatus(payout.status) === 'failed') {
      console.error(`${TAG} CRITICAL: transfer REJECTED by provider`, {
        ...params, providerStatus: payout.status,
      });
      return false;
    }
    return true;
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
      return virtualAccountClient.findByUserId(driverUserId); // provisioning race
    }
  }

  return {
    /** Driver assigned: move the held total from the rider's VA into escrow. */
    async escrowRideFunds(params: { rideId: string; riderId: string; totalNgn: number }): Promise<void> {
      const treasury = await getTreasuryDetails();
      if (!treasury) return; // no treasury — direct-settlement mode
      try {
        const riderVa = await virtualAccountClient.findByUserId(params.riderId);
        if (!riderVa) {
          console.error(`${TAG} CRITICAL: rider has no VA — nothing escrowed`, params);
          return;
        }
        const ok = await transfer({
          sourceVaId: riderVa.pouchVirtualAccountId,
          destAccountNumber: treasury.accountNumber,
          destBankName: treasury.bankName,
          amountNgn: params.totalNgn,
          idempotencyKey: `ride-escrow-${params.rideId}`,
          narration: `Wheelers ride escrow ${params.rideId}`,
        });
        if (ok) console.info(`${TAG} escrowed rider VA → treasury`, params);
      } catch (error) {
        console.error(`${TAG} CRITICAL: escrow failed — cash still in rider VA`, {
          ...params, error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    /** Ride completed: pay the driver's cut out of escrow (fee stays behind). */
    async releaseToDriver(params: {
      rideId: string;
      riderId: string;
      driverUserId: string;
      driverPayoutNgn: number;
    }): Promise<void> {
      if (!pouchClient || params.driverPayoutNgn <= 0) return;
      try {
        const driverVa = await ensureDriverVirtualAccount(params.driverUserId);
        if (!driverVa) {
          console.error(`${TAG} CRITICAL: no driver VA — driver's cash not moved`, params);
          return;
        }

        // Escrowed rides pay from the treasury; direct mode pays from the rider.
        let sourceVaId: string | null = treasuryVaId;
        if (!sourceVaId) {
          const riderVa = await virtualAccountClient.findByUserId(params.riderId);
          sourceVaId = riderVa?.pouchVirtualAccountId ?? null;
        }
        if (!sourceVaId) {
          console.error(`${TAG} CRITICAL: no source account for driver settlement`, params);
          return;
        }

        const ok = await transfer({
          sourceVaId,
          destAccountNumber: driverVa.accountNumber,
          destBankName: driverVa.bankName,
          amountNgn: params.driverPayoutNgn,
          idempotencyKey: `ride-cash-${params.rideId}`,
          narration: `Wheelers ride earnings ${params.rideId}`,
        });
        if (ok) {
          console.info(`${TAG} driver's cut released → driver VA`, {
            ...params, source: treasuryVaId ? 'treasury' : 'rider VA',
          });
        }
      } catch (error) {
        console.error(`${TAG} CRITICAL: driver settlement failed — ledger settled but cash not moved`, {
          ...params, error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    /** Ride cancelled: return the full escrow to the rider. */
    async refundToRider(params: { rideId: string; riderId: string; amountNgn: number }): Promise<void> {
      const treasury = await getTreasuryDetails();
      if (!treasury || !treasuryVaId || params.amountNgn <= 0) return; // direct mode: cash never left the rider
      try {
        const riderVa = await virtualAccountClient.findByUserId(params.riderId);
        if (!riderVa) {
          console.error(`${TAG} CRITICAL: rider has no VA — refund not moved`, params);
          return;
        }
        const ok = await transfer({
          sourceVaId: treasuryVaId,
          destAccountNumber: riderVa.accountNumber,
          destBankName: riderVa.bankName,
          amountNgn: params.amountNgn,
          idempotencyKey: `ride-refund-${params.rideId}`,
          narration: `Wheelers ride refund ${params.rideId}`,
        });
        if (ok) console.info(`${TAG} escrow refunded treasury → rider VA`, params);
      } catch (error) {
        console.error(`${TAG} CRITICAL: refund transfer failed — cash still in treasury`, {
          ...params, error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export type CashEscrow = ReturnType<typeof createCashEscrow>;
