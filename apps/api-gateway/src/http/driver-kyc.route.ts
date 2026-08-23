import type { IncomingMessage, ServerResponse } from 'http';
import { driverClient, userClient } from '@wheleers/db';
import { verifyLocalAccessToken } from '../auth/local';
import { isRecord, getString } from '../utils/object';
import { readJsonBody, sendJson } from './utils';
import { logActivity } from '../analytics/log-activity';
import type { DriverKycStorage } from '../storage/driver-kyc-storage';

interface DriverKycDeps {
  jwtSecret: string;
  kycStorage: DriverKycStorage;
}

function extractUserId(req: IncomingMessage, jwtSecret: string): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;

  try {
    const payload = verifyLocalAccessToken(authHeader.slice(7), jwtSecret);
    return payload.sub;
  } catch {
    return null;
  }
}

/**
 * POST /drivers/kyc/submit
 * Accepts base64-encoded images for NIN, licence, and selfie,
 * plus vehicle info. Uploads to S3 and creates/updates the KYC submission.
 */
export async function handleDriverKycSubmitRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DriverKycDeps,
): Promise<void> {
  const userId = extractUserId(req, deps.jwtSecret);
  if (!userId) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  const driver = await driverClient.findByUserId(userId);
  if (!driver) {
    sendJson(res, 404, { error: 'Driver record not found' });
    return;
  }

  try {
    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: 'Body must be a JSON object' });
      return;
    }

    const ninImage = getString(rawBody, 'ninImage'); // base64
    const licenceImage = getString(rawBody, 'licenceImage'); // base64
    const selfieImage = getString(rawBody, 'selfieImage'); // base64
    const vehicleImages = Array.isArray(rawBody.vehicleImages) ? rawBody.vehicleImages as string[] : [];
    const vehicleMake = getString(rawBody, 'vehicleMake');
    const vehicleModel = getString(rawBody, 'vehicleModel');
    const vehiclePlate = getString(rawBody, 'vehiclePlate');
    const vehicleYearRaw = rawBody.vehicleYear;
    const vehicleYear = typeof vehicleYearRaw === 'number' ? vehicleYearRaw : undefined;
    const phone = getString(rawBody, 'phone');

    if (!ninImage || !licenceImage || !selfieImage) {
      sendJson(res, 400, { error: 'ninImage, licenceImage, and selfieImage are required (base64)' });
      return;
    }

    if (!vehicleMake || !vehicleModel || !vehiclePlate || !vehicleYear) {
      sendJson(res, 400, { error: 'vehicleMake, vehicleModel, vehiclePlate, and vehicleYear are required' });
      return;
    }

    if (vehicleImages.length < 7) {
      sendJson(res, 400, { error: 'At least 7 vehicle photos are required' });
      return;
    }

    // Upload document images to S3
    const [ninKey, licenceKey, selfieKey] = await Promise.all([
      deps.kycStorage.upload({
        driverId: driver.id,
        type: 'nin',
        imageBuffer: Buffer.from(ninImage, 'base64'),
        mimeType: 'image/jpeg',
      }),
      deps.kycStorage.upload({
        driverId: driver.id,
        type: 'licence',
        imageBuffer: Buffer.from(licenceImage, 'base64'),
        mimeType: 'image/jpeg',
      }),
      deps.kycStorage.upload({
        driverId: driver.id,
        type: 'selfie',
        imageBuffer: Buffer.from(selfieImage, 'base64'),
        mimeType: 'image/jpeg',
      }),
    ]);

    // Upload vehicle photos
    const vehicleImageKeys = await Promise.all(
      vehicleImages.slice(0, 10).map((img, i) =>
        deps.kycStorage.upload({
          driverId: driver.id,
          type: `vehicle-${i}`,
          imageBuffer: Buffer.from(img as string, 'base64'),
          mimeType: 'image/jpeg',
        }),
      ),
    );

    // Upsert submission record
    await driverClient.upsertKycSubmission(driver.id, {
      ninImageKey: ninKey,
      licenceImageKey: licenceKey,
      selfieKey,
      vehicleImageKeys,
      vehicleMake,
      vehicleModel,
      vehiclePlate,
      vehicleYear,
    });

    // Mark as submitted
    await driverClient.submitKyc(driver.id);

    // Update driver's kycStatus
    await driverClient.updateKycStatus(driver.id, 'SUBMITTED');

    // Also persist vehicle info on the driver record
    await driverClient.updateVehicle(driver.id, {
      vehicleMake,
      vehicleModel,
      vehiclePlate,
      vehicleYear,
    });

    // Save phone number on user record if provided
    if (phone) {
      await userClient.updateProfile(userId, { phone });
    }

    logActivity({ userId, eventType: 'driver_kyc_submitted', metadata: {} });

    sendJson(res, 200, { status: 'SUBMITTED' });
  } catch (error) {
    console.error('[driver-kyc] submit failed', {
      driverId: driver.id,
      error: error instanceof Error ? error.message : String(error),
    });
    sendJson(res, 500, { error: 'KYC submission failed' });
  }
}

/**
 * GET /drivers/kyc/status
 * Returns the current KYC submission status for the authenticated driver.
 */
export async function handleDriverKycStatusRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: Pick<DriverKycDeps, 'jwtSecret'>,
): Promise<void> {
  const userId = extractUserId(req, deps.jwtSecret);
  if (!userId) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  const driver = await driverClient.findByUserId(userId);
  if (!driver) {
    sendJson(res, 404, { error: 'Driver record not found' });
    return;
  }

  const submission = await driverClient.findKycSubmission(driver.id);

  sendJson(res, 200, {
    kycStatus: driver.kycStatus,
    submission: submission ? {
      status: submission.status,
      submittedAt: submission.submittedAt,
      reviewedAt: submission.reviewedAt,
      rejectionReason: submission.rejectionReason,
      rejectedFields: submission.rejectedFields ?? [],
      vehicleMake: submission.vehicleMake,
      vehicleModel: submission.vehicleModel,
      vehiclePlate: submission.vehiclePlate,
      vehicleYear: submission.vehicleYear,
    } : null,
  });
}
