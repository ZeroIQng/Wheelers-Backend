interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  from?: string;
}

export async function sendEmail(
  params: SendEmailParams,
  apiKey: string,
): Promise<void> {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: params.from ?? 'Wheelers <noreply@wheelersng.com>',
      to: [params.to],
      subject: params.subject,
      html: params.html,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error('[resend] send failed', { status: response.status, body: text });
    throw new Error(`Email send failed (${response.status})`);
  }
}
