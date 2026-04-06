import { validateComplianceEnv, validateSharedEnv } from '@wheleers/config';
import { complianceClient } from '@wheleers/db';
import { createConsumer } from '@wheleers/kafka-client';
import { safeParseKafkaEvent, TOPICS } from '@wheleers/kafka-schemas';

const SERVICE_ID = 'compliance-worker';

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

  // Dev placeholders for required compliance env
  process.env['IPFS_API_URL'] ??= 'http://localhost:5001';
  process.env['IPFS_API_KEY'] ??= 'dev';
  process.env['COMPLIANCE_LOG_CONTRACT'] ??= '0xdev';
  process.env['RECORDING_ENCRYPTION_KEY'] ??= '0000000000000000000000000000000000000000000000000000000000000000';

  validateSharedEnv();
  validateComplianceEnv();

  const consumer = await createConsumer({ groupId: SERVICE_ID });

  await consumer.subscribe(
    [TOPICS.COMPLIANCE_EVENTS],
    async (value) => {
      const event = safeParseKafkaEvent(TOPICS.COMPLIANCE_EVENTS, value);
      if (!event) return;

      if (event.eventType === 'DISPUTE_OPENED') {
        try {
          await complianceClient.createDispute({
            id: event.disputeId,
            rideId: event.rideId,
            openedBy: event.openedBy,
            openedByRole: event.openedByRole,
            againstId: event.againstId,
            reason: event.reason,
          });
        } catch (err) {
          console.warn(`[${SERVICE_ID}] createDispute failed:`, (err as any)?.message ?? err);
        }
      }

      if (event.eventType === 'FEEDBACK_LOGGED') {
        try {
          await complianceClient.createFeedback({
            rideId: event.rideId,
            reviewerId: event.reviewerId,
            reviewerRole: event.reviewerRole,
            revieweeId: event.revieweeId,
            revieweeWallet: event.revieweeWallet,
            rating: event.rating,
            comment: event.comment,
            commentHash: event.commentHash,
          });
        } catch (err) {
          console.warn(`[${SERVICE_ID}] createFeedback failed:`, (err as any)?.message ?? err);
        }
      }

      if (event.eventType === 'RECORDING_STORED') {
        try {
          await complianceClient.createRecording({
            rideId: event.rideId,
            ipfsCid: event.ipfsCid,
            sha256Hash: event.sha256Hash,
            consentTxHash: event.consentTxHash,
            encryptedWith: event.encryptedWith,
            durationSeconds: event.durationSeconds,
          });
        } catch (err) {
          console.warn(`[${SERVICE_ID}] createRecording failed:`, (err as any)?.message ?? err);
        }
      }

      console.log(`[${SERVICE_ID}] ${event.eventType}`);
    },
  );

  console.log(`[${SERVICE_ID}] consuming`);
}

