import { PrismaClient } from '@prisma/client';

// Prisma recommends a singleton pattern to avoid exhausting the connection pool
// during hot-reload in development. In production there's only one instance
// so this just returns the same client every time.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env['NODE_ENV'] === 'development'
      ? ['query', 'warn', 'error']
      : ['error'],
  });

if (process.env['NODE_ENV'] !== 'production') {
  globalForPrisma.prisma = prisma;
}