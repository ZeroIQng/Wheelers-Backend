import { prisma } from '../prisma';
import type { ChatSenderRole } from '@prisma/client';

export const chatClient = {
  async create(params: {
    rideId: string;
    senderId: string;
    senderRole: ChatSenderRole;
    content: string;
  }) {
    return prisma.chatMessage.create({
      data: {
        rideId: params.rideId,
        senderId: params.senderId,
        senderRole: params.senderRole,
        content: params.content,
      },
    });
  },

  async findByRideId(params: {
    rideId: string;
    limit?: number;
    cursor?: string;
  }) {
    const take = params.limit ?? 50;
    const where = { rideId: params.rideId };

    const messages = await prisma.chatMessage.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take,
      ...(params.cursor
        ? { cursor: { id: params.cursor }, skip: 1 }
        : {}),
    });

    const nextCursor = messages.length === take ? messages[messages.length - 1].id : null;

    return { items: messages, nextCursor };
  },
};
