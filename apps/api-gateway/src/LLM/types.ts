export type LlmChatRole = 'system' | 'user' | 'assistant';

export interface LlmChatMessage {
  role: LlmChatRole;
  content: string;
}

export interface WhatsappConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface WhatsappBotUserContext {
  userId: string;
  name: string | null;
  phone: string;
  isNewUser: boolean;
  riderKycStatus: string;
  hasFiatWallet: boolean;
  walletBalanceNgn: number | null;
  hasVirtualAccount: boolean;
  virtualAccountDetails: {
    bankName: string;
    accountNumber: string;
    accountName: string;
  } | null;
  kycLink: string | null;
}
