export interface WhatsappNotifierDeps {
  metaAccessToken: string;
  metaPhoneNumberId: string;
  tokenSecret: string;
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

export async function sendBidNotification(
  deps: WhatsappNotifierDeps,
  phone: string,
  rideId: string,
  bidCount: number,
  userId: string,
): Promise<void> {
  // For now, send a plain text message. Template messages can be added later
  // once the Meta template is approved in Business Manager.
  const drivers = bidCount === 1 ? 'driver is' : 'drivers are';
  await sendMetaWhatsappMessage(
    deps,
    phone,
    `${bidCount} ${drivers} interested in your ride! Open the Wheelers app to view offers and pick a driver.`,
  );
}

export async function sendRideMatchedNotification(
  deps: WhatsappNotifierDeps,
  phone: string,
  driverName: string,
  vehicleModel: string,
  etaSeconds: number,
  fareNgn: number,
): Promise<void> {
  const etaMin = Math.ceil(etaSeconds / 60);
  await sendMetaWhatsappMessage(
    deps,
    phone,
    `Ride confirmed! *${driverName}* is on the way in a ${vehicleModel}. ETA: ${etaMin} min. Fare: ₦${fareNgn.toLocaleString()}`,
  );
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
