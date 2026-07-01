import { userClient, virtualAccountClient } from '@wheleers/db';
import { createLocalAccessToken } from '../auth/local';
import { GroqClient, type GroqClientConfig } from './groq.client';
import { WHATSAPP_SYSTEM_PROMPT } from './whatsapp-system-prompt';
import type {
  LlmChatMessage,
  WhatsappBotUserContext,
  WhatsappConversationMessage,
} from './types';

export interface WhatsappBotConfig extends GroqClientConfig {
  jwtSecret: string;
  appBaseUrl?: string;
}

export interface WhatsappBotRequest {
  userId: string;
  phone: string;
  profileName?: string;
  incomingMessage: string;
  isNewUser: boolean;
  recentMessages: WhatsappConversationMessage[];
}

function cleanMessage(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, 1_500);
}

function firstName(name: string | null | undefined, fallback: string): string {
  const normalized = name?.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return fallback;
  }

  return normalized.split(/\s+/)[0] ?? fallback;
}

function buildFallbackReply(context: WhatsappBotUserContext): string {
  const name = firstName(context.name, context.phone);

  if (context.isNewUser) {
    return [
      `Hey ${name}! Welcome to Wheelers 🚗`,
      'Your account is set up and your wallets are on the way.',
      'I can help you with rides, wallet, payments — just ask!',
    ].join('\n\n');
  }

  return [
    `Hey ${name}! How can I help you today?`,
    'I can assist with rides, wallet, deposits, withdrawals — just ask 🙂',
  ].join('\n\n');
}

function buildContextMessage(context: WhatsappBotUserContext): string {
  const lines = [
    'Current Wheelers user context:',
    `- userId: ${context.userId}`,
    `- name: ${context.name ?? 'unknown'}`,
    `- phone: ${context.phone}`,
    `- new WhatsApp account this message: ${context.isNewUser ? 'yes' : 'no'}`,
    `- rider KYC status: ${context.riderKycStatus}`,
    `- fiat wallet exists: ${context.hasFiatWallet ? 'yes' : 'no'}`,
    `- virtual account exists: ${context.hasVirtualAccount ? 'yes' : 'no'}`,
  ];

  if (context.riderKycStatus !== 'VERIFIED' && context.kycLink) {
    lines.push(`- KYC verification link (only share if the user asks about KYC/verification): ${context.kycLink}`);
  }

  lines.push('');
  lines.push('KYC is optional. Do NOT push verification unless the user asks about it.');
  lines.push('Use this context to answer, but do not reveal internal IDs.');
  return lines.join('\n');
}

function clampWhatsappReply(reply: string): string {
  const trimmed = reply.trim();
  if (trimmed.length <= 1_500) {
    return trimmed;
  }

  return `${trimmed.slice(0, 1_497).trim()}...`;
}

export class WhatsappBotService {
  private readonly groq: GroqClient;
  private readonly jwtSecret: string;
  private readonly appBaseUrl: string | undefined;

  constructor(config: WhatsappBotConfig) {
    this.groq = new GroqClient(config);
    this.jwtSecret = config.jwtSecret;
    this.appBaseUrl = config.appBaseUrl;
  }

  private buildKycLink(userId: string): string | null {
    if (!this.appBaseUrl) return null;
    const token = createLocalAccessToken(userId, this.jwtSecret);
    return `${this.appBaseUrl}/widget/index.html?token=${token}&apiBase=${this.appBaseUrl}`;
  }

  async generateReply(request: WhatsappBotRequest): Promise<string> {
    const user = await userClient.findById(request.userId);
    const virtualAccount = await virtualAccountClient.findByUserId(request.userId);
    const kycStatus = String(user.riderKycStatus ?? 'NONE');
    const context: WhatsappBotUserContext = {
      userId: request.userId,
      name: user.name ?? request.profileName ?? null,
      phone: request.phone,
      isNewUser: request.isNewUser,
      riderKycStatus: kycStatus,
      hasFiatWallet: Boolean(user.wallet),
      hasVirtualAccount: Boolean(virtualAccount),
      kycLink: kycStatus !== 'VERIFIED' ? this.buildKycLink(request.userId) : null,
    };

    if (!this.groq.configured) {
      return buildFallbackReply(context);
    }

    const userMessage = cleanMessage(request.incomingMessage) || 'User sent an empty WhatsApp message.';
    const messages: LlmChatMessage[] = [
      { role: 'system', content: WHATSAPP_SYSTEM_PROMPT },
      { role: 'system', content: buildContextMessage(context) },
      ...request.recentMessages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      { role: 'user', content: userMessage },
    ];

    try {
      const reply = await this.groq.complete(messages);
      return reply ? clampWhatsappReply(reply) : buildFallbackReply(context);
    } catch (error) {
      console.warn('[whatsapp] Groq reply failed', {
        userId: request.userId,
        error: error instanceof Error ? error.message : String(error),
      });
      return buildFallbackReply(context);
    }
  }
}
