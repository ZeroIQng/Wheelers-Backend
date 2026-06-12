import { PrismaClient } from '@prisma/client';

// Prisma recommends a singleton pattern to avoid exhausting the connection pool
// during hot-reload in development. In production there's only one instance
// so this just returns the same client every time.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function shouldLogPrismaQueries(): boolean {
  return process.env['PRISMA_LOG_QUERIES'] === 'true';
}

function buildDatasourceUrl(): string | undefined {
  const base = process.env['DATABASE_URL'];
  if (!base) return undefined;
  // Append connection pool params if not already present
  if (base.includes('connection_limit')) return base;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}connection_limit=20&pool_timeout=30`;
}

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: shouldLogPrismaQueries()
      ? ['query', 'warn', 'error']
      : ['warn', 'error'],
    datasourceUrl: buildDatasourceUrl(),
  });

if (process.env['NODE_ENV'] !== 'production') {
  globalForPrisma.prisma = prisma;
}
