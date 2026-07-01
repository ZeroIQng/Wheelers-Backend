export interface DriverWhatsappNotifierDeps {
  twilioAccountSid: string;
  twilioAuthToken: string;
  twilioDriverWhatsappNumber: string;
  twilioDriverFlowContentSid?: string;
  tokenSecret: string;
}

async function sendTwilioWhatsappMessage(
  deps: DriverWhatsappNotifierDeps,
  to: string,
  body: string,
): Promise<void> {
  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(deps.twilioAccountSid)}/Messages.json`;
  const authHeader = Buffer.from(`${deps.twilioAccountSid}:${deps.twilioAuthToken}`, 'utf8').toString('base64');

  const form = new URLSearchParams({
    To: `whatsapp:${to}`,
    From: `whatsapp:${deps.twilioDriverWhatsappNumber}`,
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
    console.error('[driver-notifier] Send failed', { status: response.status, payload });
  }
}

async function sendTwilioContentMessage(
  deps: DriverWhatsappNotifierDeps,
  to: string,
  contentSid: string,
  contentVariables: Record<string, string>,
): Promise<void> {
  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(deps.twilioAccountSid)}/Messages.json`;
  const authHeader = Buffer.from(`${deps.twilioAccountSid}:${deps.twilioAuthToken}`, 'utf8').toString('base64');

  const form = new URLSearchParams({
    To: `whatsapp:${to}`,
    From: `whatsapp:${deps.twilioDriverWhatsappNumber}`,
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
    console.error('[driver-notifier] Content send failed', { status: response.status, payload });
  }
}

export async function sendDriverRideOfferNotification(
  deps: DriverWhatsappNotifierDeps,
  phone: string,
  pickupAddress: string,
  destinationAddress: string,
  riderOfferNgn: number,
  paymentMethod: string,
  rideId: string,
  driverUserId: string,
): Promise<void> {
  if (deps.twilioDriverFlowContentSid) {
    const { signFlowToken } = await import('./encryption');
    const flowToken = signFlowToken(driverUserId, deps.tokenSecret);
    await sendTwilioContentMessage(deps, phone, deps.twilioDriverFlowContentSid, {
      '1': pickupAddress,
      '2': destinationAddress,
      '3': String(riderOfferNgn),
      '4': paymentMethod,
      '5': flowToken,
    });
  } else {
    await sendTwilioWhatsappMessage(
      deps,
      phone,
      `New ride request!\n📍 ${pickupAddress} → ${destinationAddress}\n💰 Rider offers ₦${riderOfferNgn.toLocaleString()} (${paymentMethod})\n\nReply "bid ${riderOfferNgn}" to accept at this price, or "bid [your price]" to counter-offer.`,
    );
  }
}

export async function sendDriverRideMatchedNotification(
  deps: DriverWhatsappNotifierDeps,
  phone: string,
  pickupAddress: string,
  destinationAddress: string,
  fareNgn: number,
): Promise<void> {
  await sendTwilioWhatsappMessage(
    deps,
    phone,
    `Ride confirmed! Pick up at *${pickupAddress}* → *${destinationAddress}*. Fare: ₦${fareNgn.toLocaleString()}. Head to pickup now!`,
  );
}

export async function sendDriverRideStartedNotification(
  deps: DriverWhatsappNotifierDeps,
  phone: string,
): Promise<void> {
  await sendTwilioWhatsappMessage(deps, phone, 'Ride started! Drive safe.');
}

export async function sendDriverRideCompletedNotification(
  deps: DriverWhatsappNotifierDeps,
  phone: string,
  fareNgn: number,
  distanceKm: number,
): Promise<void> {
  await sendTwilioWhatsappMessage(
    deps,
    phone,
    `Ride complete! Distance: ${distanceKm.toFixed(1)}km. You earned ₦${fareNgn.toLocaleString()}. Nice work!`,
  );
}

export async function sendDriverRideCancelledNotification(
  deps: DriverWhatsappNotifierDeps,
  phone: string,
  reason: string | undefined,
): Promise<void> {
  const msg = reason
    ? `Ride cancelled: ${reason}. You're back online for new requests.`
    : 'Ride cancelled by rider. You\'re back online for new requests.';
  await sendTwilioWhatsappMessage(deps, phone, msg);
}

export async function sendDriverRiderCounterOfferNotification(
  deps: DriverWhatsappNotifierDeps,
  phone: string,
  rideId: string,
  counterOfferNgn: number,
  pickupAddress: string,
  destinationAddress: string,
): Promise<void> {
  await sendTwilioWhatsappMessage(
    deps,
    phone,
    `Rider updated their offer to ₦${counterOfferNgn.toLocaleString()} for ${pickupAddress} → ${destinationAddress}. Reply "bid ${counterOfferNgn}" to accept or "bid [your price]" to counter.`,
  );
}
