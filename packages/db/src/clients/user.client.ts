import { prisma }   from '../prisma';
import type { UserRole, ConsentType } from '@prisma/client';

export const userClient = {

  // ── Reads ──────────────────────────────────────────────────────────────────

  findById: (userId: string) =>
    prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { wallet: true },
    }),

  findByPrivyDid: (privyDid: string) =>
    prisma.user.findUnique({
      where: { privyDid },
      include: { wallet: true },
    }),

  findByWallet: (walletAddress: string) =>
    prisma.user.findUnique({
      where: { walletAddress: walletAddress.toLowerCase() },
      include: { wallet: true },
    }),

  // ── Writes ─────────────────────────────────────────────────────────────────

  create: (data: {
    privyDid:      string;
    walletAddress?: string;
    username?:     string;
    email?:        string;
    role:          UserRole;
    name?:         string;
    phone?:        string;
  }) =>
    prisma.user.create({
      data: {
        privyDid: data.privyDid,
        walletAddress: data.walletAddress?.toLowerCase(),
        username: data.username,
        email: data.email,
        role: data.role,
        name: data.name,
        phone: data.phone,
      },
    }),

  updateAuthIdentity: (userId: string, data: {
    walletAddress?: string;
    username?:     string;
    email?:        string;
    name?:         string;
    phone?:        string;
  }) =>
    prisma.user.update({
      where: { id: userId },
      data: {
        walletAddress: data.walletAddress?.toLowerCase(),
        username: data.username,
        email: data.email,
        name: data.name,
        phone: data.phone,
      },
      include: { wallet: true },
    }),

  updateProfile: (userId: string, data: {
    username?: string;
    email?:    string;
    name?:     string;
    phone?:    string;
    photoUrl?: string;
  }) =>
    prisma.user.update({
      where: { id: userId },
      data,
      include: { wallet: true },
    }),

  upsertNotificationDevice: (userId: string, data: {
    expoPushToken: string;
    platform?: string;
    deviceName?: string;
    appOwnership?: string;
    enabled?: boolean;
  }) =>
    prisma.notificationDevice.upsert({
      where: {
        expoPushToken: data.expoPushToken,
      },
      create: {
        userId,
        expoPushToken: data.expoPushToken,
        platform: data.platform,
        deviceName: data.deviceName,
        appOwnership: data.appOwnership,
        enabled: data.enabled ?? true,
        lastRegisteredAt: new Date(),
      },
      update: {
        userId,
        platform: data.platform,
        deviceName: data.deviceName,
        appOwnership: data.appOwnership,
        enabled: data.enabled ?? true,
        lastRegisteredAt: new Date(),
      },
    }),

  listActiveNotificationDevices: (userId: string) =>
    prisma.notificationDevice.findMany({
      where: {
        userId,
        enabled: true,
      },
      orderBy: {
        updatedAt: 'desc',
      },
    }),

  disableNotificationDevice: (expoPushToken: string) =>
    prisma.notificationDevice.updateMany({
      where: { expoPushToken },
      data: { enabled: false },
    }),

  touchNotificationDeviceDelivery: (expoPushToken: string) =>
    prisma.notificationDevice.updateMany({
      where: { expoPushToken },
      data: { lastDeliveredAt: new Date() },
    }),

  updateRole: (userId: string, role: UserRole) =>
    prisma.user.update({
      where: { id: userId },
      data: { role },
    }),

  // ── Consent ────────────────────────────────────────────────────────────────

  // Returns the active consent record if it exists, null if not yet granted.
  findActiveConsent: (userId: string, consentType: ConsentType, consentVersion: string) =>
    prisma.userConsent.findFirst({
      where: {
        userId,
        consentType,
        consentVersion,
        revokedAt: null,
      },
    }),

  // Returns true if the user has given recording consent for the current version.
  hasRecordingConsent: async (userId: string, consentVersion = 'v1.0') => {
    const consent = await prisma.userConsent.findFirst({
      where: {
        userId,
        consentType: 'RECORDING',
        consentVersion,
        revokedAt:   null,
      },
    });
    return consent !== null;
  },

  logConsent: (data: {
    userId:          string;
    consentType:     ConsentType;
    consentVersion:  string;
    consentTxHash:   string;
  }) =>
    prisma.userConsent.create({ data }),

  revokeConsent: (userId: string, consentType: ConsentType) =>
    prisma.userConsent.updateMany({
      where:  { userId, consentType, revokedAt: null },
      data:   { revokedAt: new Date() },
    }),
};
