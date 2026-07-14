import { prisma } from '../prisma';

export const adminClient = {
  findByUsername: (username: string) =>
    prisma.adminUser.findUnique({ where: { username } }),

  findById: (id: string) =>
    prisma.adminUser.findUnique({ where: { id } }),

  create: (data: { username: string; passwordHash: string; name: string }) =>
    prisma.adminUser.create({ data }),

  list: () =>
    prisma.adminUser.findMany({
      where: { active: true },
      select: { id: true, username: true, name: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    }),

  deactivate: (id: string) =>
    prisma.adminUser.update({ where: { id }, data: { active: false } }),

  updatePassword: (id: string, passwordHash: string) =>
    prisma.adminUser.update({ where: { id }, data: { passwordHash } }),
};
