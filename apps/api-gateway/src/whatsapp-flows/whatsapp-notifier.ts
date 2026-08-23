// COMMENTED OUT: Flow-based encryption imports — using pure chat-based messaging
// import { signFlowToken } from './encryption';

import { calculateRideFees } from '@wheleers/config';
import type { WhatsappBid } from './bid-state';

export interface WhatsappNotifierDeps {
  metaAccessToken: string;
  metaPhoneNumberId: string;
}

async function sendMetaWhatsappMessage(
  deps: WhatsappNotifierDeps,
  to: string,
  body: string,
): Promise<void> {
  // Strip leading '+' — Meta expects phone numbers without it
  const recipient = to.replace(/^\+/, '');
  const endpoint = `https://graph.facebook.com/v21.0/${deps.metaPhoneNumberId}/messages`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${deps.metaAccessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipient,
      type: 'text',
      text: { body },
    }),
  });

  if (!response.ok) {
    const payload = await response.text();
    console.error('[whatsapp-notifier] Meta send failed', { status: response.status, payload });
  }
}

// ── Build a single message listing all driver bids ────────────────────────

function formatBidList(bids: WhatsappBid[], riderOfferNgn: number): string {
  const count = bids.length;
  const header = `🚗 *${count} driver${count === 1 ? '' : 's'} found!*\n\nYour offer: ₦${riderOfferNgn.toLocaleString()}\n`;

  const lines = bids.map((bid, i) => {
    const num = i + 1;
    const etaMin = Math.ceil(bid.etaSeconds / 60);
    const away =
      bid.distanceKm !== undefined
        ? `${bid.distanceKm.toFixed(1)} km · ${etaMin} min away`
        : `${etaMin} min away`;
    return `*${num}.* ${bid.driverName} — ₦${bid.counterOfferNgn.toLocaleString()}\n    ${bid.vehicleModel} · ${bid.driverRating.toFixed(1)}★ · ${away}`;
  });

  // Lead with the shortest thing that works. Riders reply to a numbered list
  // with the number — telling them to type "accept 1" made the easy path look
  // unavailable.
  const footer = [
    '',
    '━━━━━━━━━━━━━━━━━━━━━━',
    'Reply with:',
    `• *1*${count > 1 ? ` – *${count}*` : ''} — the driver's number to book them`,
    '• A *price* (e.g. "1500") — to counter-offer and get new drivers',
    '• *more* — to see more drivers',
    '• *cancel* — to cancel the ride',
  ];

  return [header, ...lines, ...footer].join('\n');
}

export { formatBidList };

// ── Send batched bid notification (1 message with all drivers) ────────────

export async function sendBidNotification(
  deps: WhatsappNotifierDeps,
  phone: string,
  bids: WhatsappBid[],
  riderOfferNgn: number,
): Promise<void> {
  const message = formatBidList(bids, riderOfferNgn);
  await sendMetaWhatsappMessage(deps, phone, message);
}

export async function sendRideMatchedNotification(
  deps: WhatsappNotifierDeps,
  phone: string,
  driverName: string,
  vehicleModel: string,
  vehiclePlate: string,
  etaSeconds: number,
  fareNgn: number,
  driverRating: number,
): Promise<void> {
  const etaMin = Math.ceil(etaSeconds / 60);
  const fees = calculateRideFees(fareNgn);
  const msg = [
    `✅ *Ride confirmed!*`,
    ``,
    `Driver: *${driverName}*`,
    `Vehicle: ${vehicleModel} (${vehiclePlate})`,
    `Rating: ${driverRating.toFixed(1)}★`,
    `Fare: ₦${fees.totalNgn.toLocaleString()}`,
    ``,
    `🚗 ${driverName} is on the way — they'll be with you in ~${etaMin} min.`,
  ].join('\n');

  await sendMetaWhatsappMessage(deps, phone, msg);
}

export async function sendDriverArrivedNotification(
  deps: WhatsappNotifierDeps,
  phone: string,
): Promise<void> {
  await sendMetaWhatsappMessage(
    deps,
    phone,
    'Your driver has arrived! 🚗 They are waiting at your pickup point.',
  );
}

export async function sendRideStartedNotification(
  deps: WhatsappNotifierDeps,
  phone: string,
): Promise<void> {
  await sendMetaWhatsappMessage(deps, phone, 'Your ride has started! Stay safe. 🚗');
}

export async function sendRideCompletedNotification(
  deps: WhatsappNotifierDeps,
  phone: string,
  fareNgn: number,
  distanceKm: number,
): Promise<void> {
  const fees = calculateRideFees(fareNgn);
  await sendMetaWhatsappMessage(
    deps,
    phone,
    `Ride complete! Distance: ${distanceKm.toFixed(1)}km. Fare: ₦${fees.totalNgn.toLocaleString()}. Thanks for riding with Wheelers! 🎉`,
  );
}

export async function sendRideCancelledNotification(
  deps: WhatsappNotifierDeps,
  phone: string,
  reason: string | undefined,
): Promise<void> {
  const msg = reason
    ? `Your ride was cancelled: ${reason}. You can request another ride anytime.`
    : 'Your ride was cancelled. You can request another ride anytime.';
  await sendMetaWhatsappMessage(deps, phone, msg);
}

export async function sendBidTimeoutNotification(
  deps: WhatsappNotifierDeps,
  phone: string,
): Promise<void> {
  await sendMetaWhatsappMessage(
    deps,
    phone,
    'No driver accepted this ride request. Please try booking another ride.',
  );
}

export async function sendRiderPaidNotification(
  deps: WhatsappNotifierDeps,
  phone: string,
  newBalanceNgn: number,
): Promise<void> {
  await sendMetaWhatsappMessage(
    deps,
    phone,
    `Payment received! Your wallet balance is now ₦${newBalanceNgn.toLocaleString()}. Your driver has been notified and is on the way.`,
  );
}

export async function sendDepositConfirmation(
  deps: WhatsappNotifierDeps,
  phone: string,
  amountNgn: number,
  newBalanceNgn: number,
): Promise<void> {
  const msg = [
    `Deposit received!`,
    ``,
    `Amount: NGN ${amountNgn.toLocaleString()}`,
    `Wallet balance: NGN ${newBalanceNgn.toLocaleString()}`,
    ``,
    `Your wallet is ready. Book a ride anytime!`,
  ].join('\n');

  await sendMetaWhatsappMessage(deps, phone, msg);
}

export async function sendSearchingNotification(
  deps: WhatsappNotifierDeps,
  phone: string,
  pickupAddress: string,
  destAddress: string,
  offerNgn: number,
  paymentMethod: string,
): Promise<void> {
  const payLabel = paymentMethod === 'WALLET' ? 'Wallet' : 'Cash';
  const msg = [
    `🔍 *Looking for drivers!*`,
    ``,
    `📍 ${pickupAddress}`,
    `📍 ${destAddress}`,
    ``,
    `Offer: ₦${offerNgn.toLocaleString()}`,
    `Payment: ${payLabel}`,
    ``,
    `I'll message you when drivers respond! 🚗`,
  ].join('\n');

  await sendMetaWhatsappMessage(deps, phone, msg);
}

export async function sendGroupRideGroupedNotification(
  deps: WhatsappNotifierDeps,
  phone: string,
  riderCount: number,
  totalDistanceKm: number,
  totalDurationSeconds: number,
): Promise<void> {
  const durationMin = Math.max(1, Math.ceil(totalDurationSeconds / 60));
  const msg = [
    `🎉 *Group found!*`,
    ``,
    `You've been matched with ${riderCount - 1} other rider${riderCount - 1 === 1 ? '' : 's'} heading your way.`,
    `Shared route: ${totalDistanceKm.toFixed(1)} km · ~${durationMin} min`,
    ``,
    `We're finding a driver for your group now — I'll message you the moment one accepts. 🚗`,
  ].join('\n');

  await sendMetaWhatsappMessage(deps, phone, msg);
}

export async function sendGroupRideDriverAssignedNotification(
  deps: WhatsappNotifierDeps,
  phone: string,
  driverName: string,
  vehicleModel: string,
  vehiclePlate: string,
  driverRating: number,
  etaSeconds: number,
): Promise<void> {
  const etaMin = Math.max(1, Math.ceil(etaSeconds / 60));
  const msg = [
    `✅ *Driver found for your group ride!*`,
    ``,
    `Driver: *${driverName}*`,
    `Vehicle: ${vehicleModel}${vehiclePlate ? ` (${vehiclePlate})` : ''}`,
    `Rating: ${driverRating.toFixed(1)}★`,
    ``,
    `🚗 ${driverName} is on the way — they'll reach the first pickup in ~${etaMin} min.`,
  ].join('\n');

  await sendMetaWhatsappMessage(deps, phone, msg);
}

export async function sendGroupRideDispatchNotification(
  deps: WhatsappNotifierDeps,
  phone: string,
): Promise<void> {
  const msg = [
    `🚗 *Drivers are seeing your group ride now!*`,
    ``,
    `You're the lead rider — driver offers will land here as a numbered list, and your pick drives the whole group.`,
    ``,
    `Reply with a driver's *number* to book them, or a *price* to counter-offer.`,
  ].join('\n');

  await sendMetaWhatsappMessage(deps, phone, msg);
}
