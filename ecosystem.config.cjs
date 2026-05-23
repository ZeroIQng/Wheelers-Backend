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
const dockerEnv = parseEnvFile(path.join(cwd, ".env.docker"));
const workspaceEnv = parseEnvFile(path.join(cwd, ".env"));
const mergedEnv = {
  ...workspaceEnv,
  ...dockerEnv,
  ...process.env,
};

module.exports = {
  apps: [
    {
      name: "whatsapp-gateway",
      cwd,
      script: "npm",
      args: "run start:whatsapp-gateway",
      env: {
        NODE_ENV: "production",
        WHATSAPP_GATEWAY_PORT: mergedEnv.WHATSAPP_GATEWAY_PORT || "3010",
        WHATSAPP_GATEWAY_TOKEN: mergedEnv.WHATSAPP_GATEWAY_TOKEN,
        WHATSAPP_CLIENT_ID: mergedEnv.WHATSAPP_CLIENT_ID,
        WHATSAPP_SESSION_PATH:
          mergedEnv.WHATSAPP_SESSION_PATH ||
          "/var/lib/wheelers-whatsapp/.wwebjs_auth",
        WHATSAPP_HEADLESS: mergedEnv.WHATSAPP_HEADLESS || "true",
        WHATSAPP_CHROME_EXECUTABLE_PATH:
          mergedEnv.WHATSAPP_CHROME_EXECUTABLE_PATH || "/usr/bin/google-chrome",
      },
    },
  ],
};
