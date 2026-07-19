import { signFlowToken } from './encryption';

export interface WhatsappNotifierDeps {
  metaAccessToken: string;
  metaPhoneNumberId: string;
  tokenSecret: string;
  flowId?: string;
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

async function sendMetaTemplateMessage(
  deps: WhatsappNotifierDeps,
  to: string,
  templateName: string,
  parameters: Array<{ type: 'text'; text: string }>,
): Promise<void> {
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
      to: recipient,
      type: 'template',
      template: {
        name: templateName,
        language: { code: 'en' },
        components: [
          {
            type: 'body',
            parameters,
          },
        ],
      },
    }),
  });

  if (!response.ok) {
    const payload = await response.text();
    console.error('[whatsapp-notifier] Meta template send failed', { status: response.status, payload });
  }
}

async function sendFlowInteractiveMessage(
  deps: WhatsappNotifierDeps,
  to: string,
  bodyText: string,
  ctaText: string,
  rideId: string,
  userId: string,
): Promise<void> {
  // If flow ID isn't configured, fall back to plain text
  if (!deps.flowId) {
    await sendMetaWhatsappMessage(deps, to, bodyText);
    return;
  }

  const recipient = to.replace(/^\+/, '');
  const endpoint = `https://graph.facebook.com/v21.0/${deps.metaPhoneNumberId}/messages`;
  const flowToken = signFlowToken(`${rideId}:${userId}`, deps.tokenSecret);

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
      type: 'interactive',
      interactive: {
        type: 'flow',
        body: { text: bodyText },
        action: {
          name: 'flow',
          parameters: {
            flow_id: deps.flowId,
            flow_cta: ctaText,
            flow_token: flowToken,
            mode: 'draft',
            flow_message_version: '3',
            flow_action: 'data_exchange',
            flow_action_payload: {
              screen: 'BID_LIST',
            },
          },
        },
      },
    }),
  });

  if (!response.ok) {
    const payload = await response.text();
    console.error('[whatsapp-notifier] Meta flow send failed', { status: response.status, payload });
  }
}

export async function sendBidNotification(
  deps: WhatsappNotifierDeps,
  phone: string,
  rideId: string,
  bidCount: number,
  userId: string,
): Promise<void> {
  const drivers = bidCount === 1 ? 'driver is' : 'drivers are';
  const bodyText = `${bidCount} ${drivers} interested in your ride!`;

  await sendFlowInteractiveMessage(
    deps,
    phone,
    bodyText,
    'View Offers',
    rideId,
    userId,
  );
}

export async function sendBookRideFlowMessage(
  deps: WhatsappNotifierDeps,
  phone: string,
  userId: string,
  routeSummary: string,
): Promise<void> {
  // If flow ID isn't configured, fall back to plain text
  if (!deps.flowId) {
    await sendMetaWhatsappMessage(deps, phone, `${routeSummary}\n\nSend your offer amount to book!`);
    return;
  }

  const recipient = phone.replace(/^\+/, '');
  const endpoint = `https://graph.facebook.com/v21.0/${deps.metaPhoneNumberId}/messages`;
  // Use 'new' as rideId since ride hasn't been created yet
  const flowToken = signFlowToken(`new:${userId}`, deps.tokenSecret);

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
      type: 'interactive',
      interactive: {
        type: 'flow',
        body: { text: routeSummary },
        action: {
          name: 'flow',
          parameters: {
            flow_id: deps.flowId,
            flow_cta: 'Book This Ride',
            flow_token: flowToken,
            mode: 'draft',
            flow_message_version: '3',
            flow_action: 'data_exchange',
            flow_action_payload: {
              screen: 'RIDE_SETUP',
            },
          },
        },
      },
    }),
  });

  if (!response.ok) {
    const payload = await response.text();
    console.error('[whatsapp-notifier] Meta book-ride flow send failed', { status: response.status, payload });
  }
}

export async function sendRideMatchedNotification(
  deps: WhatsappNotifierDeps,
  phone: string,
  rideId: string,
  userId: string,
  driverName: string,
  vehicleModel: string,
  etaSeconds: number,
  fareNgn: number,
): Promise<void> {
  const etaMin = Math.ceil(etaSeconds / 60);
  const bodyText = `Ride confirmed! *${driverName}* is on the way in a ${vehicleModel}. ETA: ${etaMin} min. Fare: ₦${fareNgn.toLocaleString()}`;

  // Send flow button to view driver profile (part of main ride flow)
  if (!deps.flowId) {
    await sendMetaWhatsappMessage(deps, phone, bodyText);
    return;
  }

  const recipient = phone.replace(/^\+/, '');
  const endpoint = `https://graph.facebook.com/v21.0/${deps.metaPhoneNumberId}/messages`;
  const flowToken = signFlowToken(`${rideId}:${userId}`, deps.tokenSecret);

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
      type: 'interactive',
      interactive: {
        type: 'flow',
        body: { text: bodyText },
        action: {
          name: 'flow',
          parameters: {
            flow_id: deps.flowId,
            flow_cta: 'View Driver',
            flow_token: flowToken,
            mode: 'draft',
            flow_message_version: '3',
            flow_action: 'data_exchange',
            flow_action_payload: {
              screen: 'DRIVER_PROFILE',
            },
          },
        },
      },
    }),
  });

  if (!response.ok) {
    const payload = await response.text();
    console.error('[whatsapp-notifier] Meta ride flow send failed', { status: response.status, payload });
  }
}

export async function sendRideStartedNotification(
  deps: WhatsappNotifierDeps,
  phone: string,
): Promise<void> {
  await sendMetaWhatsappMessage(deps, phone, 'Your ride has started! Stay safe.');
}

export async function sendRideCompletedNotification(
  deps: WhatsappNotifierDeps,
  phone: string,
  fareNgn: number,
  distanceKm: number,
): Promise<void> {
  await sendMetaWhatsappMessage(
    deps,
    phone,
    `Ride complete! Distance: ${distanceKm.toFixed(1)}km. Fare: ₦${fareNgn.toLocaleString()}. Thanks for riding with Wheelers!`,
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
    'No drivers accepted your ride request. Try again with a different offer?',
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
