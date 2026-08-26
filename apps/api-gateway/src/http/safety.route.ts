import type { IncomingMessage, ServerResponse } from 'http';
import { rideClient, safetyAlertClient } from '@wheleers/db';
import type { SafetyAlertKind, SafetyAlertRole } from '@wheleers/db';
import { authenticateHttpUser, HttpAuthError } from './authenticate';
import { readJsonBody, sendJson } from './utils';
import { getNumber, getString, isRecord } from '../utils/object';
import type { GatewayPublisher } from '../websocket/publisher';

/**
 * The emergency button, from both sides of the trip.
 *
 * The design rule for everything in this file: **an alert must get recorded**.
 * A rider being followed off their route does not care that their phone could
 * not resolve a street name, and neither should this endpoint. Anything the
 * client fails to supply is stored as null and the alert still lands.
 *
 * That is also why raising is idempotent per open incident: a frightened person
 * presses the button repeatedly, and an operator should see one emergency, not
 * eight rows of the same one.
 */

interface SafetyRouteDeps {
  jwtSecret: string;
  publisher?: GatewayPublisher;
}

const ALERT_KINDS: SafetyAlertKind[] = [
  'SOS',
  'UNSAFE_DRIVING',
  'ROUTE_DEVIATION',
  'ACCIDENT',
  'MEDICAL',
];

function parseKind(value: unknown): SafetyAlertKind {
  const raw = typeof value === 'string' ? value.toUpperCase() : '';
  return (ALERT_KINDS as string[]).includes(raw) ? (raw as SafetyAlertKind) : 'SOS';
}

function parseRole(value: unknown, fallback: SafetyAlertRole): SafetyAlertRole {
  const raw = typeof value === 'string' ? value.toUpperCase() : '';
  return raw === 'DRIVER' || raw === 'RIDER' ? raw : fallback;
}

function serializeAlert(alert: Awaited<ReturnType<typeof safetyAlertClient.raise>>) {
  return {
    id: alert.id,
    status: alert.status,
    kind: alert.kind,
    raisedByRole: alert.raisedByRole,
    rideId: alert.rideId,
    interstateDepartureId: alert.interstateDepartureId,
    lat: alert.lat,
    lng: alert.lng,
    address: alert.address,
    note: alert.note,
    createdAt: alert.createdAt.toISOString(),
    acknowledgedAt: alert.acknowledgedAt?.toISOString() ?? null,
    resolvedAt: alert.resolvedAt?.toISOString() ?? null,
    cancelledAt: alert.cancelledAt?.toISOString() ?? null,
  };
}

function handleFailure(res: ServerResponse, error: unknown, fallback: string): void {
  if (error instanceof HttpAuthError) {
    sendJson(res, 401, { error: 'Sign in again to use the emergency button.' });
    return;
  }

  console.error('[safety]', {
    error: error instanceof Error ? error.message : String(error),
  });
  sendJson(res, 500, { error: fallback });
}

/**
 * Work out who the person raising this is travelling with, so the operator sees
 * both sides of the incident. Best-effort by design — a lookup failure here
 * must never stop the alert being written.
 */
async function findTripContext(
  userId: string,
  rideId: string | null,
): Promise<{ rideId: string | null; counterpartUserId: string | null }> {
  if (!rideId) {
    return { rideId: null, counterpartUserId: null };
  }

  try {
    const ride = await rideClient.findWithDriver(rideId);
    const counterpart =
      ride.riderId === userId ? ride.driver?.userId ?? null : ride.riderId ?? null;

    return { rideId, counterpartUserId: counterpart };
  } catch (error) {
    console.warn('[safety] could not resolve trip context for alert', {
      rideId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { rideId, counterpartUserId: null };
  }
}

/** POST /safety/alerts — raise an emergency. */
export async function handleRaiseSafetyAlertRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: SafetyRouteDeps,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const rawBody = await readJsonBody(req).catch(() => ({}));
    const body = isRecord(rawBody) ? rawBody : {};

    const rideId = getString(body, 'rideId') ?? null;

    // One live incident per person. A second press while an alert is already
    // open returns the same alert instead of creating a duplicate.
    const existing = await safetyAlertClient.findOpenForUser(user.id, rideId);
    if (existing) {
      sendJson(res, 200, { alert: serializeAlert(existing), alreadyOpen: true });
      return;
    }

    const context = await findTripContext(user.id, rideId);
    const alert = await safetyAlertClient.raise({
      userId: user.id,
      raisedByRole: parseRole(body['role'], user.role === 'DRIVER' ? 'DRIVER' : 'RIDER'),
      kind: parseKind(body['kind']),
      rideId: context.rideId,
      interstateDepartureId: getString(body, 'interstateDepartureId') ?? null,
      counterpartUserId: context.counterpartUserId,
      lat: getNumber(body, 'lat') ?? null,
      lng: getNumber(body, 'lng') ?? null,
      address: getString(body, 'address') ?? null,
      note: getString(body, 'note') ?? null,
    });

    console.warn('[safety] EMERGENCY ALERT RAISED', {
      alertId: alert.id,
      userId: user.id,
      role: alert.raisedByRole,
      rideId: alert.rideId,
      hasLocation: alert.lat !== null && alert.lng !== null,
    });

    sendJson(res, 201, { alert: serializeAlert(alert), alreadyOpen: false });
  } catch (error) {
    handleFailure(
      res,
      error,
      'We could not send your alert. Call the emergency line on 112 if you are in danger.',
    );
  }
}

/** GET /safety/alerts/active — the caller's own live alert, if they have one. */
export async function handleActiveSafetyAlertRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: SafetyRouteDeps,
  url: URL,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const rideId = url.searchParams.get('rideId');
    const alert = await safetyAlertClient.findOpenForUser(user.id, rideId);

    sendJson(res, 200, { alert: alert ? serializeAlert(alert) : null });
  } catch (error) {
    handleFailure(res, error, 'We could not check your alert status.');
  }
}

/** GET /safety/alerts — the caller's own history. */
export async function handleListSafetyAlertsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: SafetyRouteDeps,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const alerts = await safetyAlertClient.listForUser(user.id);
    sendJson(res, 200, { items: alerts.map(serializeAlert) });
  } catch (error) {
    handleFailure(res, error, 'We could not load your safety alerts.');
  }
}

/** POST /safety/alerts/:id/cancel — "false alarm, I am fine." */
export async function handleCancelSafetyAlertRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: SafetyRouteDeps,
  alertId: string,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(req, deps.jwtSecret);
    const rawBody = await readJsonBody(req).catch(() => ({}));
    const reason = isRecord(rawBody) ? getString(rawBody, 'reason') : undefined;

    const alert = await safetyAlertClient.cancelOwn({
      id: alertId,
      userId: user.id,
      reason: reason ?? undefined,
    });

    if (!alert) {
      sendJson(res, 409, {
        error: 'This alert is already being handled by our safety team.',
      });
      return;
    }

    console.info('[safety] alert cancelled by the person who raised it', {
      alertId,
      userId: user.id,
    });

    sendJson(res, 200, { alert: serializeAlert(alert) });
  } catch (error) {
    handleFailure(res, error, 'We could not cancel your alert.');
  }
}
