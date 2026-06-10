const fs = require("fs");
const path = require("path");

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const content = fs.readFileSync(filePath, "utf8");
  const result = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = rawLine.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = rawLine.slice(0, separatorIndex).trim();
    const value = rawLine.slice(separatorIndex + 1).trim();
    result[key] = value.replace(/^['"]|['"]$/g, "");
  }

  return result;
}

const cwd = __dirname;
const composeEnv = parseEnvFile(path.join(cwd, ".env.compose"));
const dockerAppEnvFile = composeEnv.DOCKER_APP_ENV_FILE || process.env.DOCKER_APP_ENV_FILE;
const dockerAppEnv = dockerAppEnvFile
  ? parseEnvFile(
      path.isAbsolute(dockerAppEnvFile)
        ? dockerAppEnvFile
        : path.join(cwd, dockerAppEnvFile),
    )
  : {};
const workspaceEnv = parseEnvFile(path.join(cwd, ".env"));
const mergedEnv = {
  ...dockerAppEnv,
  ...composeEnv,
  ...workspaceEnv,
  ...process.env,
};

if (!workspaceEnv.DATABASE_URL && !process.env.DATABASE_URL) {
  const user = mergedEnv.POSTGRES_USER || "postgres";
  const password = mergedEnv.POSTGRES_PASSWORD || "postgres";
  const database = mergedEnv.POSTGRES_DB || "wheelers";
  mergedEnv.DATABASE_URL = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(
    password,
  )}@localhost:5432/${encodeURIComponent(database)}`;
}

if (!workspaceEnv.REDIS_URL && !process.env.REDIS_URL) {
  mergedEnv.REDIS_URL = "redis://localhost:6379";
}

if (!workspaceEnv.KAFKA_BROKERS && !process.env.KAFKA_BROKERS) {
  mergedEnv.KAFKA_BROKERS = "localhost:29092";
}

function app(name, args, extraEnv = {}) {
  return {
    name,
    cwd,
    script: "npm",
    args,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 3000,
    env: {
      NODE_ENV: "production",
      KAFKAJS_NO_PARTITIONER_WARNING: "1",
      ...mergedEnv,
      ...extraEnv,
    },
  };
}

module.exports = {
  apps: [
    app("api-gateway", "run start:api-gateway", {
      PORT: mergedEnv.PORT || "3000",
    }),
    app("ride-service", "run start:ride-service"),
    app("group-ride", "run start:group-ride"),
    app("payment-service", "run start:payment-service"),
    app("wallet-service", "run start:wallet-service"),
    app("notification-worker", "run start:notification-worker"),
    app("defi-scheduler", "run start:defi-scheduler"),
    app("whatsapp-gateway", "run start:whatsapp-gateway", {
      WHATSAPP_GATEWAY_PORT: mergedEnv.WHATSAPP_GATEWAY_PORT || "3010",
      WHATSAPP_SESSION_PATH:
        mergedEnv.WHATSAPP_SESSION_PATH ||
        "/var/lib/wheelers-whatsapp/.wwebjs_auth",
      WHATSAPP_HEADLESS: mergedEnv.WHATSAPP_HEADLESS || "true",
      WHATSAPP_CHROME_EXECUTABLE_PATH:
        mergedEnv.WHATSAPP_CHROME_EXECUTABLE_PATH || "/usr/bin/google-chrome",
    }),
  ],
};
