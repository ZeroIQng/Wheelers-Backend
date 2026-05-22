import { z } from 'zod';

const WhatsappEnvSchema = z.object({
  WHATSAPP_GATEWAY_PORT: z.string().default('3010'),
  WHATSAPP_GATEWAY_TOKEN: z.string().min(1),
  WHATSAPP_CLIENT_ID: z.string().min(1).default('wheelers-otp'),
  WHATSAPP_SESSION_PATH: z.string().min(1).default('apps/whatsapp-gateway/.wwebjs_auth'),
  WHATSAPP_HEADLESS: z.enum(['true', 'false']).default('true'),
  WHATSAPP_CHROME_EXECUTABLE_PATH: z.string().min(1).optional(),
});

export type WhatsappEnv = z.infer<typeof WhatsappEnvSchema>;

export function validateWhatsappEnv(): WhatsappEnv {
  const result = WhatsappEnvSchema.safeParse(process.env);
  if (!result.success) {
    console.error('[config] whatsapp-gateway env errors:\n', result.error.format());
    process.exit(1);
  }
  return result.data;
}
