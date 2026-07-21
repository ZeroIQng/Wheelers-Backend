import type { IncomingMessage, ServerResponse } from 'http';
import { driverClient } from '@wheleers/db';
import { isRecord, getString } from '../utils/object';
import { readJsonBody, sendJson } from './utils';
import { verifyAdminAuth } from './admin-auth.route';
import type { DriverKycStorage } from '../storage/driver-kyc-storage';

interface AdminRouteDeps {
  adminApiKey: string;
  jwtSecret: string;
  kycStorage: DriverKycStorage;
}

/**
 * GET /admin/drivers?status=SUBMITTED
 * Lists drivers by KYC submission status.
 */
export async function handleAdminListDriversRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminRouteDeps,
): Promise<void> {
  const auth = await verifyAdminAuth(req, deps);
  if (!auth) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  const submissions = await driverClient.findPendingKycSubmissions();

  const drivers = submissions.map((submission) => ({
    driverId: submission.driverId,
    name: submission.driver.user.name,
    email: submission.driver.user.email,
    phone: submission.driver.user.phone,
    vehicleMake: submission.vehicleMake,
    vehicleModel: submission.vehicleModel,
    vehiclePlate: submission.vehiclePlate,
    vehicleYear: submission.vehicleYear,
    status: submission.status,
    submittedAt: submission.submittedAt,
  }));

  sendJson(res, 200, { drivers });
}

/**
 * GET /admin/drivers/:driverId
 * Returns full driver details with signed document URLs.
 */
export async function handleAdminGetDriverRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminRouteDeps,
  driverId: string,
): Promise<void> {
  const auth = await verifyAdminAuth(req, deps);
  if (!auth) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  const driver = await driverClient.findById(driverId).catch(() => null);
  if (!driver) {
    sendJson(res, 404, { error: 'Driver not found' });
    return;
  }

  const submission = await driverClient.findKycSubmission(driverId);
  if (!submission) {
    sendJson(res, 404, { error: 'No KYC submission found' });
    return;
  }

  // Generate signed URLs for documents
  const [ninUrl, licenceUrl, selfieUrl] = await Promise.all([
    submission.ninImageKey ? deps.kycStorage.getSignedUrl(submission.ninImageKey) : null,
    submission.licenceImageKey ? deps.kycStorage.getSignedUrl(submission.licenceImageKey) : null,
    submission.selfieKey ? deps.kycStorage.getSignedUrl(submission.selfieKey) : null,
  ]);

  // Generate signed URLs for vehicle images
  const vehicleImageUrls: string[] = [];
  if (submission.vehicleImageKeys?.length) {
    const urls = await Promise.all(
      submission.vehicleImageKeys.map((key) => deps.kycStorage.getSignedUrl(key)),
    );
    vehicleImageUrls.push(...urls);
  }

  sendJson(res, 200, {
    driverId: driver.id,
    userId: driver.userId,
    name: driver.user.name,
    email: driver.user.email,
    phone: driver.user.phone,
    kycStatus: driver.kycStatus,
    submission: {
      status: submission.status,
      submittedAt: submission.submittedAt,
      vehicleMake: submission.vehicleMake,
      vehicleModel: submission.vehicleModel,
      vehiclePlate: submission.vehiclePlate,
      vehicleYear: submission.vehicleYear,
      ninImageUrl: ninUrl,
      licenceImageUrl: licenceUrl,
      selfieUrl,
      vehicleImageUrls,
      rejectionReason: submission.rejectionReason,
      rejectedFields: submission.rejectedFields ?? [],
      fieldStatuses: (submission.fieldStatuses as Record<string, unknown>) ?? {},
    },
  });
}

/**
 * POST /admin/drivers/:driverId/field-review
 * Approve or reject a single KYC field.
 * Body: { field: "nin"|"licence"|"selfie"|"vehicle", status: "approved"|"rejected", reason?: string }
 */
export async function handleAdminFieldReviewRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminRouteDeps,
  driverId: string,
): Promise<void> {
  const auth = await verifyAdminAuth(req, deps);
  if (!auth) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  const rawBody = await readJsonBody(req);
  if (!isRecord(rawBody)) {
    sendJson(res, 400, { error: 'Body must be a JSON object' });
    return;
  }

  const field = getString(rawBody, 'field');
  const status = getString(rawBody, 'status');
  const reason = getString(rawBody, 'reason') ?? '';
  const validFields = ['nin', 'licence', 'selfie', 'vehicle'];
  const validStatuses = ['approved', 'rejected'];

  if (!field || !validFields.includes(field)) {
    sendJson(res, 400, { error: 'field must be one of: nin, licence, selfie, vehicle' });
    return;
  }

  if (!status || !validStatuses.includes(status)) {
    sendJson(res, 400, { error: 'status must be "approved" or "rejected"' });
    return;
  }

  const submission = await driverClient.findKycSubmission(driverId);
  if (!submission || submission.status !== 'SUBMITTED') {
    sendJson(res, 400, { error: 'No pending submission to review' });
    return;
  }

  const existing = (submission.fieldStatuses as Record<string, unknown>) ?? {};
  const updated: Record<string, unknown> = {
    ...existing,
    [field]: { status, reason, reviewedBy: auth.adminName, reviewedAt: new Date().toISOString() },
  };

  await driverClient.updateFieldStatuses(driverId, updated as Record<string, string>);

  sendJson(res, 200, { field, status, fieldStatuses: updated });
}

/**
 * POST /admin/drivers/:driverId/approve
 * Approves the driver's KYC submission.
 */
export async function handleAdminApproveDriverRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminRouteDeps,
  driverId: string,
): Promise<void> {
  const auth = await verifyAdminAuth(req, deps);
  if (!auth) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  const submission = await driverClient.findKycSubmission(driverId);
  if (!submission || submission.status !== 'SUBMITTED') {
    sendJson(res, 400, { error: 'No pending submission to approve' });
    return;
  }

  await driverClient.approveKycSubmission(driverId, auth.adminName);
  await driverClient.updateKycStatus(driverId, 'APPROVED');

  // TODO: Send push notification to driver about approval

  sendJson(res, 200, { status: 'APPROVED' });
}

/**
 * POST /admin/drivers/:driverId/reject
 * Rejects the driver's KYC submission with a reason.
 */
export async function handleAdminRejectDriverRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminRouteDeps,
  driverId: string,
): Promise<void> {
  const auth = await verifyAdminAuth(req, deps);
  if (!auth) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  const rawBody = await readJsonBody(req);
  if (!isRecord(rawBody)) {
    sendJson(res, 400, { error: 'Body must be a JSON object' });
    return;
  }

  const reason = getString(rawBody, 'reason') ?? 'Documents did not pass review';
  const rawFields = Array.isArray(rawBody.rejectedFields) ? rawBody.rejectedFields : [];
  const validFields = ['nin', 'licence', 'selfie', 'vehicle'];
  const rejectedFields = rawFields.filter((f: unknown): f is string => typeof f === 'string' && validFields.includes(f));

  const submission = await driverClient.findKycSubmission(driverId);
  if (!submission || submission.status !== 'SUBMITTED') {
    sendJson(res, 400, { error: 'No pending submission to reject' });
    return;
  }

  await driverClient.rejectKycSubmission(driverId, auth.adminName, reason, rejectedFields);
  await driverClient.updateKycStatus(driverId, 'REJECTED');

  // TODO: Send push notification to driver about rejection

  sendJson(res, 200, { status: 'REJECTED', reason, rejectedFields });
}
