# Rider signup and phone verification

The rider app's account journey: **sign up → enter phone → code on WhatsApp or
SMS → verified**. Code lives in `apps/api-gateway/src/http/auth.route.ts`,
`social-auth.route.ts`, `phone.route.ts` and `src/otp/channels.ts`.

## The rider app's entry

Sign in with **Apple, Google, or email + password** and you are in. There is no
phone-verification step between creating an account and using the app.

```
/rider-auth      Apple · Google · email  →  /rider
/account-auth    the email form           →  /rider
```

`role-selection.tsx` (misnamed — it never picked a role), `phone-auth.tsx` and
`otp-verify.tsx` are gone, along with the pending-phone state they needed.
Signing in *is* onboarding, so `getAuthenticatedRoute` is now one line.

Riders already signed in on the previous build carried
`onboardingRoute: "/otp-verify"` on their device. That route no longer exists,
so the state reader migrates them straight to `/rider` rather than leaving them
on a dead screen — covered by a test.

The phone OTP endpoints still exist on the backend (the MCP server signs riders
in by phone), they are simply no longer part of the app's flow.

## Signup

| Endpoint | Body | Notes |
|---|---|---|
| `POST /auth/signup` | `{email\|username, password, fullName?, phone?, role?}` | `role` defaults to `RIDER`. |
| `POST /auth/google` | `{idToken, role?}` | `role` defaults to `RIDER`. |
| `POST /auth/apple` | `{idToken, name?, role?}` | Apple only sends the name on first auth. |

All three return `{ accessToken, user }`.

**Fixed here:** Google and Apple sign-in previously hardcoded `role: DRIVER` and
always created a `Driver` record, so a rider signing up with Google silently
became a driver. Role is now a parameter defaulting to `RIDER`, and the Driver
record is only created for `DRIVER`/`BOTH`.

## Phone verification

Phone is a separate step after signup, because social sign-in never provides one.

1. `POST /auth/phone/send-otp` `{phone}` (bearer token) → `{sent, channel, expiresInSeconds}`
2. `POST /auth/phone/verify-otp` `{code}` (bearer token) → phone written to the account

`channel` tells the app what to say — "check WhatsApp" or "check your SMS".

## Delivery: a chain, not a provider

Meta's Cloud API is cheapest but only delivers free-form messages within 24
hours of that person last messaging us, and this account is **blocked from
creating the AUTHENTICATION template** that would lift the limit (error subcode
2388185). A brand-new rider cannot be reached by Meta at all — which is exactly
who signs up in the app.

So delivery walks a chain, cheapest first, and stops at the first success:

```
meta_whatsapp  →  twilio_whatsapp  →  twilio_sms
```

Twilio SMS has no window and needs no template, so it is the backstop that makes
signup reliable. A closed window on one channel (Meta 131047, Twilio 63016) is
detected and treated as "try the next one" rather than a failure.

If every channel fails, the error names each attempt instead of saying
"could not send".

### Twilio Verify

Set `TWILIO_VERIFY_SERVICE_SID` and Twilio generates, sends and checks the code
itself over SMS or WhatsApp — no template approval on either side. When Verify
is configured it replaces the raw Twilio channels, and verification is routed
back to Twilio instead of comparing against a hash we never generated.

### Configuration

```
# Meta (cheapest, 24h window unless a template is approved)
META_ACCESS_TOKEN=…
META_PHONE_NUMBER_ID=…
META_OTP_TEMPLATE_NAME=…          # optional, lifts the 24h limit

# Twilio — the reliable fallback
TWILIO_ACCOUNT_SID=…
TWILIO_AUTH_TOKEN=…
TWILIO_WHATSAPP_NUMBER=+14155238886
TWILIO_FROM_NUMBER=+14155550100    # SMS sender
TWILIO_VERIFY_SERVICE_SID=…        # optional, supersedes the two above

OTP_CHANNEL_ORDER=meta_whatsapp,twilio_whatsapp,twilio_sms   # optional override
```

Any channel whose credentials are missing is skipped, so partial configuration
degrades instead of breaking.

## Tests

```sh
npm run test:otp            # the delivery chain, all HTTP stubbed
npm run test:rider-signup   # the full journey against a real database
```

`test:otp` covers channel detection, Meta-first ordering, both flavours of
closed-window fallback, Verify issue/check, and the aggregate failure message.
`test:rider-signup` walks signup → phone → code → verify, and asserts that
Google sign-in produces a rider, that `role=driver` still produces a driver,
that a used code cannot be replayed, and that a malformed number sends nothing.
