export interface WhatsappNotifierDeps {
  twilioAccountSid: string;
  twilioAuthToken: string;
  twilioWhatsappNumber: string;
  twilioFlowContentSid?: string;
  tokenSecret: string;
}

async function sendTwilioWhatsappMessage(
  deps: WhatsappNotifierDeps,
  to: string,
  body: string,
): Promise<void> {
  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(deps.twilioAccountSid)}/Messages.json`;
  const authHeader = Buffer.from(`${deps.twilioAccountSid}:${deps.twilioAuthToken}`, 'utf8').toString('base64');

  const form = new URLSearchParams({
    To: `whatsapp:${to}`,
    From: `whatsapp:${deps.twilioWhatsappNumber}`,
    Body: body,
  });

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Basic ${authHeader}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });

  if (!response.ok) {
    const payload = await response.text();
    console.error('[whatsapp-notifier] Send failed', { status: response.status, payload });
  }
}

async function sendTwilioContentMessage(
  deps: WhatsappNotifierDeps,
  to: string,
  contentSid: string,
  contentVariables: Record<string, string>,
): Promise<void> {
  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(deps.twilioAccountSid)}/Messages.json`;
  const authHeader = Buffer.from(`${deps.twilioAccountSid}:${deps.twilioAuthToken}`, 'utf8').toString('base64');

  const form = new URLSearchParams({
    To: `whatsapp:${to}`,
    From: `whatsapp:${deps.twilioWhatsappNumber}`,
    ContentSid: contentSid,
    ContentVariables: JSON.stringify(contentVariables),
  });

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Basic ${authHeader}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });

  if (!response.ok) {
    const payload = await response.text();
    console.error('[whatsapp-notifier] Content send failed', { status: response.status, payload });
  }
}

export async function sendBidNotification(
  deps: WhatsappNotifierDeps,
  phone: string,
  rideId: string,
  bidCount: number,
  userId: string,
): Promise<void> {
  if (deps.twilioFlowContentSid) {
    // flow_token is signed so it can't be forged
    const { signFlowToken } = await import('./encryption');
    const flowToken = signFlowToken(`${rideId}:${userId}`, deps.tokenSecret);
    // Send Flow CTA button so rider can tap to see bids
    await sendTwilioContentMessage(deps, phone, deps.twilioFlowContentSid, {
      '1': String(bidCount),
      '2': flowToken,
    });
  } else {
    // Fallback: plain text message
    const drivers = bidCount === 1 ? 'driver is' : 'drivers are';
    await sendTwilioWhatsappMessage(
      deps,
      phone,
      `${bidCount} ${drivers} interested in your ride! Open the Wheelers app to view offers and pick a driver.`,
    );
  }
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
  await sendTwilioWhatsappMessage(
    deps,
    phone,
    `Ride confirmed! *${driverName}* is on the way in a ${vehicleModel}. ETA: ${etaMin} min. Fare: ₦${fareNgn.toLocaleString()}`,
  );
}

export async function sendRideStartedNotification(
  deps: WhatsappNotifierDeps,
  phone: string,
): Promise<void> {
  await sendTwilioWhatsappMessage(deps, phone, 'Your ride has started! Stay safe.');
}

export async function sendRideCompletedNotification(
  deps: WhatsappNotifierDeps,
  phone: string,
  fareNgn: number,
  distanceKm: number,
): Promise<void> {
  await sendTwilioWhatsappMessage(
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
  await sendTwilioWhatsappMessage(deps, phone, msg);
}

export async function sendBidTimeoutNotification(
  deps: WhatsappNotifierDeps,
  phone: string,
): Promise<void> {
  await sendTwilioWhatsappMessage(
    deps,
    phone,
    'No drivers accepted your ride request. Try again with a different offer?',
  );
}
