import type { IncomingMessage, ServerResponse } from 'http';

const MAX_BODY_SIZE_BYTES = 1_000_000;

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;

    if (size > MAX_BODY_SIZE_BYTES) {
      throw new Error('Request body too large');
    }

    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  const body = Buffer.concat(chunks).toString('utf8');
  if (!body.trim()) {
    return {};
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new Error('Invalid JSON body');
  }
}

export function sendJson(res: ServerResponse, statusCode: number, payload: Record<string, unknown>): void {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(body));
  res.end(body);
}

export function applyCorsHeaders(
  req: IncomingMessage,
  res: ServerResponse,
  allowedOrigins: Set<string>,
): void {
  const requestOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : null;

  if (requestOrigin && allowedOrigins.has(requestOrigin)) {
    res.setHeader('access-control-allow-origin', requestOrigin);
  } else if (allowedOrigins.size > 0) {
    const first = allowedOrigins.values().next().value;
    if (typeof first === 'string') {
      res.setHeader('access-control-allow-origin', first);
    }
  }

  res.setHeader('vary', 'origin');
  res.setHeader('access-control-allow-methods', 'POST,GET,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type,authorization');
}
