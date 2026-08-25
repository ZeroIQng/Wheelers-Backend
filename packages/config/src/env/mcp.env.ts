import { z } from 'zod';

const McpEnvSchema = z.object({
  MCP_PORT: z.string().default('3020'),
  // Public https origin clients are configured with, e.g. https://mcp.wheelersng.com.
  // Used as the OAuth issuer and for redirect/metadata URLs — must be exact.
  MCP_PUBLIC_URL: z.string().url(),
  // Where this process reaches the api-gateway. Same host under pm2 → loopback.
  MCP_GATEWAY_BASE_URL: z.string().url().default('http://127.0.0.1:3000'),
  // Optional override; derived from MCP_GATEWAY_BASE_URL (http→ws, https→wss) + /ws when unset.
  MCP_GATEWAY_WS_URL: z.string().url().optional(),
  REDIS_URL: z.string().url(),
  // Lifetime of an MCP access token. Refresh tokens live as long as the
  // underlying gateway session (30 days), then the user signs in again.
  MCP_ACCESS_TOKEN_TTL_S: z.coerce.number().int().positive().default(60 * 60 * 24),
  // Accept a raw api-gateway JWT as a bearer (handy for `claude mcp add --header`).
  MCP_ALLOW_GATEWAY_TOKENS: z.enum(['true', 'false']).default('true'),
  // Browser origins allowed to call /mcp directly (Claude web app).
  MCP_CORS_ORIGINS: z.string().default('https://claude.ai,https://claude.com'),
  // Geocoding for address → coordinates. Same key the gateway uses.
  GOOGLE_MAPS_API_KEY: z.string().optional().transform((v) => v?.trim() || undefined),
  GEOCODE_REGION: z.string().default('ng'),
  GEOCODE_FALLBACK_COUNTRY: z.string().default('NG'),
});

export type McpEnv = z.infer<typeof McpEnvSchema>;

export function validateMcpEnv(): McpEnv {
  const result = McpEnvSchema.safeParse(process.env);
  if (!result.success) {
    console.error('[config] mcp-server env errors:\n', result.error.format());
    process.exit(1);
  }
  return result.data;
}
