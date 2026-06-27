import type { MessageContext } from '@wheleers/kafka-client';
import { safeParseKafkaEvent, TOPICS } from '@wheleers/kafka-schemas';
import { MultiChainWalletService } from '@wheleers/multi-chain-wallet';
import type { CryptoWalletEventsProducer } from '../producers/crypto-wallet-events.producer';

export function createCryptoWalletEventsConsumer(params: {
  cryptoWalletEventsProducer: CryptoWalletEventsProducer;
  serviceId?: string;
}) {
  const {
    cryptoWalletEventsProducer,
    serviceId = 'wallet-service',
  } = params;

  const walletService = new MultiChainWalletService();

  return {
    async handle(value: unknown, _context: MessageContext): Promise<void> {
      const event = safeParseKafkaEvent(TOPICS.CRYPTO_WALLET_EVENTS, value);
      if (!event) return;

      // ── Create wallet ────────────────────────────────────────────
      if (event.eventType === 'CRYPTO_WALLET_CREATE_REQUESTED') {
        try {
          console.log(`[${serviceId}] creating crypto wallet for user ${event.userId}`);

          const wallet = walletService.createWallet(event.password);

          await cryptoWalletEventsProducer.publishWalletCreated({
            userId: event.userId,
            encryptedMnemonic: wallet.encryptedMnemonic,
            encryptionSalt: wallet.encryptionSalt,
            addresses: wallet.addresses,
          }, { key: event.userId });

          console.log(
            `[${serviceId}] crypto wallet created for user ${event.userId}, ` +
            `${wallet.addresses.length} chain addresses derived`,
          );
        } catch (error) {
          console.error(`[${serviceId}] crypto wallet creation failed:`, getErrorMessage(error));
          throw error;
        }
        return;
      }

      // ── Get deposit addresses ────────────────────────────────────
      if (event.eventType === 'CRYPTO_DEPOSIT_REQUESTED') {
        try {
          console.log(`[${serviceId}] getting deposit addresses for user ${event.userId}`);

          const mnemonic = walletService.recoverWallet(
            event.encryptedMnemonic,
            event.password,
            event.encryptionSalt,
          );

          if (!mnemonic) {
            console.warn(`[${serviceId}] failed to decrypt mnemonic for user ${event.userId}`);
            return;
          }

          let deposits;
          if (event.chainId) {
            const deposit = walletService.getDepositAddress(mnemonic.mnemonic, event.chainId);
            deposits = deposit ? [deposit] : [];
          } else {
            deposits = walletService.getDepositAddresses(mnemonic.mnemonic);
          }

          await cryptoWalletEventsProducer.publishDepositAddress({
            userId: event.userId,
            deposits,
          }, { key: event.userId });

          console.log(`[${serviceId}] deposit addresses sent for user ${event.userId}`);
        } catch (error) {
          console.error(`[${serviceId}] deposit address retrieval failed:`, getErrorMessage(error));
          throw error;
        }
        return;
      }

      // ── Withdraw / Transfer ──────────────────────────────────────
      if (event.eventType === 'CRYPTO_WITHDRAW_REQUESTED') {
        try {
          console.log(
            `[${serviceId}] processing crypto withdrawal for user ${event.userId}, ` +
            `chain=${event.chainId}, amount=${event.amount}, to=${event.toAddress}`,
          );

          const recovered = walletService.recoverWallet(
            event.encryptedMnemonic,
            event.password,
            event.encryptionSalt,
          );

          if (!recovered) {
            await cryptoWalletEventsProducer.publishWithdrawCompleted({
              userId: event.userId,
              chainId: event.chainId,
              chainName: '',
              txHash: '',
              success: false,
              error: 'Failed to decrypt wallet',
              amount: event.amount,
              toAddress: event.toAddress,
            }, { key: event.userId });
            return;
          }

          let result;
          try {
            result = await walletService.withdraw(recovered.mnemonic, {
              chainId: event.chainId,
              toAddress: event.toAddress,
              amount: event.amount,
              token: event.token,
            });
          } catch (withdrawError) {
            // Publish failure instead of crashing to DLQ
            await cryptoWalletEventsProducer.publishWithdrawCompleted({
              userId: event.userId,
              chainId: event.chainId,
              chainName: '',
              txHash: '',
              success: false,
              error: getErrorMessage(withdrawError),
              amount: event.amount,
              toAddress: event.toAddress,
            }, { key: event.userId });

            console.error(
              `[${serviceId}] crypto withdrawal failed for user ${event.userId}:`,
              getErrorMessage(withdrawError),
            );
            return;
          }

          await cryptoWalletEventsProducer.publishWithdrawCompleted({
            userId: event.userId,
            chainId: result.chainId,
            chainName: result.chainName,
            txHash: result.hash,
            success: result.success,
            error: result.error,
            amount: event.amount,
            toAddress: event.toAddress,
          }, { key: event.userId });

          console.log(
            `[${serviceId}] crypto withdrawal ${result.success ? 'completed' : 'failed'} ` +
            `for user ${event.userId}, txHash=${result.hash}`,
          );
        } catch (error) {
          console.error(`[${serviceId}] crypto withdrawal event handling failed:`, getErrorMessage(error));
          throw error;
        }
        return;
      }

      // ── Balance check ────────────────────────────────────────────
      if (event.eventType === 'CRYPTO_BALANCE_REQUESTED') {
        try {
          console.log(`[${serviceId}] checking crypto balance for user ${event.userId}`);

          const recovered = walletService.recoverWallet(
            event.encryptedMnemonic,
            event.password,
            event.encryptionSalt,
          );

          if (!recovered) {
            console.warn(`[${serviceId}] failed to decrypt mnemonic for balance check, user ${event.userId}`);
            await cryptoWalletEventsProducer.publishBalanceResult({
              userId: event.userId,
              balances: [],
            }, { key: event.userId });
            return;
          }

          try {
            if (event.chainId) {
              const balance = await walletService.getBalance(recovered.mnemonic, event.chainId);
              await cryptoWalletEventsProducer.publishBalanceResult({
                userId: event.userId,
                balances: [{
                  chainId: event.chainId,
                  chainName: '',
                  balance: balance.formatted,
                  decimals: balance.decimal,
                }],
              }, { key: event.userId });
            } else {
              const allBalances = await walletService.getAllBalances(recovered.mnemonic);
              await cryptoWalletEventsProducer.publishBalanceResult({
                userId: event.userId,
                balances: allBalances.map((b) => ({
                  chainId: b.chainId,
                  chainName: b.chainName,
                  balance: b.balance.formatted,
                  decimals: b.balance.decimal,
                })),
              }, { key: event.userId });
            }
          } catch (balanceError) {
            console.error(`[${serviceId}] RPC balance check failed for user ${event.userId}:`, getErrorMessage(balanceError));
            // Publish empty result rather than crashing to DLQ
            await cryptoWalletEventsProducer.publishBalanceResult({
              userId: event.userId,
              balances: [],
            }, { key: event.userId });
            return;
          }

          console.log(`[${serviceId}] balance result sent for user ${event.userId}`);
        } catch (error) {
          console.error(`[${serviceId}] balance check event handling failed:`, getErrorMessage(error));
          throw error;
        }
        return;
      }
    },
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
