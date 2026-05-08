import { prisma } from '../prisma';

export const outboxClient = {
  /** Insert a single unpublished outbox event. */
  create: (data: { topic: string; key?: string | null; payload: unknown }) =>
    prisma.outboxEvent.create({
      data: {
        topic: data.topic,
        key: data.key ?? null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        payload: data.payload as any,
      },
    }),

  /** Fetch the oldest N unpublished events. */
  findUnpublished: (limit = 100) =>
    prisma.outboxEvent.findMany({
      where: { publishedAt: null },
      orderBy: { createdAt: 'asc' },
      take: limit,
    }),

  /** Mark a batch of events as published (idempotent). */
  markPublished: (ids: string[]) =>
    prisma.outboxEvent.updateMany({
      where: { id: { in: ids } },
      data: { publishedAt: new Date() },
    }),

  /** Hard-delete events published more than `olderThanDays` days ago. */
  purgePublished: (olderThanDays = 7) =>
    prisma.outboxEvent.deleteMany({
      where: {
        publishedAt: {
          lt: new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1_000),
        },
      },
    }),
};