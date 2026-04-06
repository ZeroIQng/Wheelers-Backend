import { DEFI, validateDefiEnv, validateSharedEnv } from '@wheleers/config';
import { defiClient } from '@wheleers/db';
import { createProducer } from '@wheleers/kafka-client';
import { TOPICS } from '@wheleers/kafka-schemas';

const SERVICE_ID = 'defi-scheduler';

bootstrap().catch((err) => {
  console.error(`[${SERVICE_ID}] fatal`, err);
  process.exit(1);
});

async function bootstrap(): Promise<void> {
  process.env['NODE_ENV'] ??= 'development';
  process.env['KAFKA_CLIENT_ID'] ??= SERVICE_ID;
  process.env['KAFKA_BROKERS'] ??= 'localhost:9092';
  process.env['DATABASE_URL'] ??= 'postgresql://postgres:postgres@localhost:5432/wheelers';
  process.env['REDIS_URL'] ??= 'redis://localhost:6379';

  validateSharedEnv();
  const env = validateDefiEnv();

  const producer = await createProducer({ serviceId: SERVICE_ID });

  const threshold = Number(env.IDLE_THRESHOLD_USDT);
  const idleHours = Number(env.IDLE_HOURS);

  console.log(`[${SERVICE_ID}] running idle checks: threshold=${threshold} idleHours=${idleHours}`);

  // Simple interval (cron parsing intentionally omitted for now).
  const intervalMs = 60 * 60 * 1000;
  await runOnce();
  setInterval(() => void runOnce(), intervalMs);

  async function runOnce(): Promise<void> {
    try {
      const wallets = await defiClient.findIdleWallets(threshold, idleHours);
      for (const w of wallets) {
        const tier = recommendTier(Number(w.balanceUsdt));

        await producer.send(TOPICS.DEFI_EVENTS, {
          eventType: 'IDLE_FUNDS_DETECTED',
          userId: w.userId,
          walletAddress: w.address,
          idleBalanceUsdt: Number(w.balanceUsdt),
          idleSinceHours: idleHours,
          recommendedTier: tier,
          userOptedIn: false,
          timestamp: new Date().toISOString(),
        } as any, { key: w.userId });
      }
      console.log(`[${SERVICE_ID}] idle wallets found: ${wallets.length}`);
    } catch (err) {
      console.warn(`[${SERVICE_ID}] idle check failed:`, (err as any)?.message ?? err);
    }
  }
}

function recommendTier(balanceUsdt: number): 'tier1' | 'tier2' | 'tier3' {
  if (balanceUsdt >= DEFI.TIER3_MIN_USDT) return 'tier3';
  if (balanceUsdt >= DEFI.TIER2_MIN_USDT) return 'tier2';
  return 'tier1';
}

