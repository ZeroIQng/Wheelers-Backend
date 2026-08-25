import IORedis from 'ioredis';

export type Redis = IORedis;

export function createRedis(redisUrl: string): Redis {
  return new IORedis(redisUrl, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
  });
}
