import { Socket } from 'net';

type RespValue = string | number | null | RespValue[];

interface PendingRequest {
  resolve: (value: RespValue) => void;
  reject: (error: Error) => void;
}

function toBuffer(value: string): Buffer {
  return Buffer.from(value, 'utf8');
}

function encodeCommand(args: string[]): Buffer {
  const parts: Buffer[] = [toBuffer(`*${args.length}\r\n`)];

  for (const arg of args) {
    const argBuffer = toBuffer(arg);
    parts.push(toBuffer(`$${argBuffer.byteLength}\r\n`));
    parts.push(argBuffer);
    parts.push(toBuffer('\r\n'));
  }

  return Buffer.concat(parts);
}

function readLine(buffer: Buffer, start: number): { line: string; next: number } | null {
  const end = buffer.indexOf('\r\n', start, 'utf8');
  if (end === -1) return null;

  return {
    line: buffer.toString('utf8', start, end),
    next: end + 2,
  };
}

function parseRespValue(buffer: Buffer, offset = 0): { value: RespValue; next: number } | null {
  if (offset >= buffer.length) return null;

  const prefix = String.fromCharCode(buffer[offset]);

  if (prefix === '+' || prefix === '-' || prefix === ':') {
    const line = readLine(buffer, offset + 1);
    if (!line) return null;

    if (prefix === '+') return { value: line.line, next: line.next };
    if (prefix === '-') return { value: `ERR:${line.line}`, next: line.next };
    return { value: Number(line.line), next: line.next };
  }

  if (prefix === '$') {
    const line = readLine(buffer, offset + 1);
    if (!line) return null;

    const length = Number(line.line);
    if (length === -1) {
      return { value: null, next: line.next };
    }

    const end = line.next + length;
    if (buffer.length < end + 2) return null;

    const value = buffer.toString('utf8', line.next, end);
    return {
      value,
      next: end + 2,
    };
  }

  if (prefix === '*') {
    const line = readLine(buffer, offset + 1);
    if (!line) return null;

    const count = Number(line.line);
    if (count === -1) {
      return { value: null, next: line.next };
    }

    const values: RespValue[] = [];
    let cursor = line.next;

    for (let i = 0; i < count; i += 1) {
      const parsed = parseRespValue(buffer, cursor);
      if (!parsed) return null;

      values.push(parsed.value);
      cursor = parsed.next;
    }

    return {
      value: values,
      next: cursor,
    };
  }

  throw new Error(`Unsupported RESP prefix: ${prefix}`);
}

interface RedisConnectionOptions {
  host: string;
  port: number;
  password?: string;
  db?: number;
}

function parseRedisUrl(redisUrl: string): RedisConnectionOptions {
  const parsed = new URL(redisUrl);

  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error('REDIS_URL must use redis:// or rediss://');
  }

  if (parsed.protocol === 'rediss:') {
    throw new Error('rediss:// is not yet supported by the built-in Redis client');
  }

  const host = parsed.hostname;
  const port = parsed.port ? Number(parsed.port) : 6379;
  const db = parsed.pathname && parsed.pathname !== '/' ? Number(parsed.pathname.slice(1)) : undefined;

  return {
    host,
    port,
    password: parsed.password || undefined,
    db: Number.isFinite(db) ? db : undefined,
  };
}

export class RedisClient {
  private socket: Socket | null = null;
  private pending: PendingRequest[] = [];
  private receiveBuffer: Buffer = Buffer.alloc(0);
  private connected = false;
  private messageListener?: (channel: string, payload: string) => void;

  constructor(private readonly redisUrl: string) {}

  async connect(): Promise<void> {
    if (this.connected) return;

    const options = parseRedisUrl(this.redisUrl);

    await new Promise<void>((resolve, reject) => {
      const socket = new Socket();

      const onError = (error: Error) => {
        socket.destroy();
        reject(error);
      };

      socket.once('error', onError);
      socket.connect(options.port, options.host, async () => {
        socket.off('error', onError);
        this.socket = socket;

        socket.on('data', (chunk) => {
          this.onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        socket.on('error', (error) => this.failPending(error));
        socket.on('close', () => {
          this.connected = false;
        });

        this.connected = true;

        try {
          if (options.password) {
            await this.send('AUTH', options.password);
          }

          if (typeof options.db === 'number' && Number.isFinite(options.db)) {
            await this.send('SELECT', String(options.db));
          }

          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  async disconnect(): Promise<void> {
    if (!this.socket) return;

    try {
      await this.send('QUIT');
    } catch {
      // ignore disconnect errors
    }

    this.socket.destroy();
    this.socket = null;
    this.connected = false;
  }

  onMessage(listener: (channel: string, payload: string) => void): void {
    this.messageListener = listener;
  }

  async subscribe(channel: string): Promise<void> {
    await this.send('SUBSCRIBE', channel);
  }

  async publish(channel: string, payload: string): Promise<number> {
    const result = await this.send('PUBLISH', channel, payload);
    return typeof result === 'number' ? result : 0;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds && ttlSeconds > 0) {
      await this.send('SET', key, value, 'EX', String(ttlSeconds));
      return;
    }

    await this.send('SET', key, value);
  }

  async get(key: string): Promise<string | null> {
    const result = await this.send('GET', key);
    return typeof result === 'string' ? result : null;
  }

  async del(key: string): Promise<void> {
    await this.send('DEL', key);
  }

  async sadd(key: string, value: string): Promise<void> {
    await this.send('SADD', key, value);
  }

  async srem(key: string, value: string): Promise<void> {
    await this.send('SREM', key, value);
  }

  async smembers(key: string): Promise<string[]> {
    const result = await this.send('SMEMBERS', key);
    if (!Array.isArray(result)) return [];

    return result
      .filter((entry): entry is string => typeof entry === 'string')
      .filter((entry) => entry.length > 0);
  }

  async send(...args: string[]): Promise<RespValue> {
    if (!this.socket || !this.connected) {
      throw new Error('Redis client is not connected');
    }

    const payload = encodeCommand(args);

    return new Promise<RespValue>((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.socket!.write(payload, (error) => {
        if (error) {
          const current = this.pending.pop();
          current?.reject(error);
        }
      });
    });
  }

  private onData(chunk: Buffer): void {
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk]);

    while (true) {
      const parsed = parseRespValue(this.receiveBuffer, 0);
      if (!parsed) {
        return;
      }

      this.receiveBuffer = this.receiveBuffer.subarray(parsed.next);
      this.handleResponse(parsed.value);
    }
  }

  private handleResponse(value: RespValue): void {
    if (Array.isArray(value) && value.length >= 3 && value[0] === 'message') {
      const channel = typeof value[1] === 'string' ? value[1] : '';
      const payload = typeof value[2] === 'string' ? value[2] : '';

      if (channel && this.messageListener) {
        this.messageListener(channel, payload);
      }
      return;
    }

    const pending = this.pending.shift();
    if (!pending) {
      return;
    }

    if (typeof value === 'string' && value.startsWith('ERR:')) {
      pending.reject(new Error(value.slice(4)));
      return;
    }

    pending.resolve(value);
  }

  private failPending(error: Error): void {
    while (this.pending.length > 0) {
      const pending = this.pending.shift();
      pending?.reject(error);
    }
  }
}
