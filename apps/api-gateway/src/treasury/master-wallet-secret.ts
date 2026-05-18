import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

type GatewayTreasuryEnv = {
  AWS_REGION?: string;
  STELLAR_MASTER_WALLET_SECRET_NAME?: string;
  STELLAR_SECRET_KEY?: string;
  POUCH_MASTER_WALLET_ADDRESS: string;
};

type StellarMasterWalletSecret = {
  STELLAR_PUBLIC_KEY?: string;
  STELLAR_SECRET_KEY: string;
};

let cachedSecret: StellarMasterWalletSecret | null = null;
let cachedSecretName: string | null = null;
let inFlightSecretPromise: Promise<StellarMasterWalletSecret | null> | null = null;

function parseSecretPayload(secretString: string): StellarMasterWalletSecret {
  const parsed = JSON.parse(secretString) as Record<string, unknown>;
  const secretKey = parsed["STELLAR_SECRET_KEY"];
  const publicKey = parsed["STELLAR_PUBLIC_KEY"];

  if (typeof secretKey !== "string" || secretKey.trim().length === 0) {
    throw new Error("Secrets Manager payload is missing STELLAR_SECRET_KEY.");
  }

  return {
    STELLAR_SECRET_KEY: secretKey.trim(),
    STELLAR_PUBLIC_KEY:
      typeof publicKey === "string" && publicKey.trim().length > 0
        ? publicKey.trim()
        : undefined,
  };
}

async function fetchSecretFromAws(
  region: string,
  secretName: string,
): Promise<StellarMasterWalletSecret> {
  const client = new SecretsManagerClient({ region });
  const response = await client.send(
    new GetSecretValueCommand({
      SecretId: secretName,
    }),
  );

  if (typeof response.SecretString !== "string" || response.SecretString.trim().length === 0) {
    throw new Error("Secrets Manager returned an empty STELLAR master wallet secret.");
  }

  return parseSecretPayload(response.SecretString);
}

export async function loadStellarMasterWalletSecret(
  env: GatewayTreasuryEnv,
): Promise<StellarMasterWalletSecret | null> {
  if (env.STELLAR_SECRET_KEY?.trim()) {
    return {
      STELLAR_SECRET_KEY: env.STELLAR_SECRET_KEY.trim(),
    };
  }

  const secretName = env.STELLAR_MASTER_WALLET_SECRET_NAME?.trim();
  if (!secretName) {
    return null;
  }

  if (cachedSecret && cachedSecretName === secretName) {
    return cachedSecret;
  }

  if (!env.AWS_REGION?.trim()) {
    throw new Error(
      "AWS_REGION must be set when STELLAR_MASTER_WALLET_SECRET_NAME is configured.",
    );
  }

  if (!inFlightSecretPromise) {
    inFlightSecretPromise = fetchSecretFromAws(env.AWS_REGION.trim(), secretName)
      .then((secret) => {
        cachedSecret = secret;
        cachedSecretName = secretName;
        return secret;
      })
      .finally(() => {
        inFlightSecretPromise = null;
      });
  }

  return inFlightSecretPromise;
}

export async function hydrateProcessEnvWithStellarMasterWalletSecret(
  env: GatewayTreasuryEnv,
): Promise<StellarMasterWalletSecret | null> {
  const secret = await loadStellarMasterWalletSecret(env);
  if (!secret) {
    return null;
  }

  process.env["STELLAR_SECRET_KEY"] = secret.STELLAR_SECRET_KEY;
  if (secret.STELLAR_PUBLIC_KEY) {
    process.env["STELLAR_PUBLIC_KEY"] = secret.STELLAR_PUBLIC_KEY;
  }

  if (
    secret.STELLAR_PUBLIC_KEY &&
    secret.STELLAR_PUBLIC_KEY !== env.POUCH_MASTER_WALLET_ADDRESS
  ) {
    console.warn("[api-gateway][treasury] master wallet public key mismatch", {
      pouchMasterWalletAddress: env.POUCH_MASTER_WALLET_ADDRESS,
      secretPublicKey: secret.STELLAR_PUBLIC_KEY,
    });
  }

  return secret;
}
