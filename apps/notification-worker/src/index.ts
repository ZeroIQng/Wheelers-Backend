import { validateNotificationEnv, validateSharedEnv } from '@wheleers/config';
import { prisma } from '@wheleers/db';
import { createConsumer } from '@wheleers/kafka-client';
import { safeParseKafkaEvent, TOPICS } from '@wheleers/kafka-schemas';

const SERVICE_ID = 'notification-worker';

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

  // Dev placeholders for required notification env
  process.env['EXPO_ACCESS_TOKEN'] ??= 'dev';
  process.env['TWILIO_ACCOUNT_SID'] ??= 'dev';
  process.env['TWILIO_AUTH_TOKEN'] ??= 'dev';
  process.env['TWILIO_FROM_NUMBER'] ??= 'dev';

  validateSharedEnv();
  validateNotificationEnv();

  const consumer = await createConsumer({ groupId: SERVICE_ID });

  await consumer.subscribe([TOPICS.NOTIFICATION_EVENTS], async (value) => {
    const event = safeParseKafkaEvent(TOPICS.NOTIFICATION_EVENTS, value);
    if (!event) return;

    if (event.eventType === 'IN_APP_SEND') {
      try {
        await prisma.notification.create({
          data: {
            id: event.notificationId,
            userId: event.userId,
            title: event.title,
            body: event.body,
            category: categoryToDb(event.category),
            referenceId: event.referenceId ?? null,
            referenceType: event.referenceType ?? null,
            read: event.read ?? false,
          } as any,
        });
      } catch (err) {
        console.warn(`[${SERVICE_ID}] notification create failed:`, (err as any)?.message ?? err);
      }
    }

    // PUSH_SEND and SMS_SEND are intentionally stubbed here.
    console.log(`[${SERVICE_ID}] ${event.eventType} -> user=${event.userId}`);
  });

  console.log(`[${SERVICE_ID}] consuming`);
}

function categoryToDb(category: string): any {
  // Prisma enum is NotificationCategory (RIDE, PAYMENT, ...)
  switch (category) {
    case 'ride':
      return 'RIDE';
    case 'payment':
      return 'PAYMENT';
    case 'wallet':
      return 'WALLET';
    case 'defi':
      return 'DEFI';
    case 'dispute':
      return 'DISPUTE';
    case 'kyc':
      return 'KYC';
    case 'system':
    default:
      return 'SYSTEM';
  }
}

