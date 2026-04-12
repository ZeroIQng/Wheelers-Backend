import { logFeedbackOnStellar, logRecordingHashOnStellar } from '@wheleers/blockchain';
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

  validateSharedEnv();
  const complianceEnv = validateComplianceEnv();

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
            id: event.feedbackId,
            rideId: event.rideId,
            reviewerId: event.reviewerId,
            reviewerRole: event.reviewerRole,
            revieweeId: event.revieweeId,
            revieweeWallet: event.revieweeWallet,
            rating: event.rating,
            comment: event.comment,
            commentHash: event.commentHash,
          });

          const txHash = await logFeedbackOnStellar({
            feedbackId: event.feedbackId,
            rideId: event.rideId,
            revieweeWallet: event.revieweeWallet,
            rating: event.rating,
            commentHash: event.commentHash,
            network: complianceEnv.STELLAR_NETWORK,
          });

          await complianceClient.updateFeedbackOnchainTx(event.feedbackId, txHash);
        } catch (err) {
          console.warn(`[${SERVICE_ID}] createFeedback failed:`, (err as any)?.message ?? err);
          throw err;
        }
      }

      if (event.eventType === 'RECORDING_STORED') {
        try {
          await complianceClient.createRecording({
            id: event.recordingId,
            rideId: event.rideId,
            ipfsCid: event.ipfsCid,
            sha256Hash: event.sha256Hash,
            consentTxHash: event.consentTxHash,
            encryptedWith: event.encryptedWith,
            durationSeconds: event.durationSeconds,
          });

          const txHash = await logRecordingHashOnStellar({
            recordingId: event.recordingId,
            rideId: event.rideId,
            sha256Hex: event.sha256Hash,
            network: complianceEnv.STELLAR_NETWORK,
          });

          await complianceClient.updateRecordingOnchainTx(event.recordingId, txHash);
        } catch (err) {
          console.warn(`[${SERVICE_ID}] createRecording failed:`, (err as any)?.message ?? err);
          throw err;
        }
      }

      console.log(`[${SERVICE_ID}] ${event.eventType}`);
    },
  );

  console.log(`[${SERVICE_ID}] consuming`);
}
