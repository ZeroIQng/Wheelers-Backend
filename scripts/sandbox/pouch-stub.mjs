/**
 * Stand-in for the Pouch/Liquifia fiat API. Accepts anything, moves nothing.
 * Every call is logged so a test run shows exactly which money operations the
 * backend attempted.
 */
import http from 'node:http';

export function startPouchStub(port) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      console.log(`[pouch-stub] ${req.method} ${req.url}${body ? ` ${body.slice(0, 200)}` : ''}`);
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      // Generic happy-path shape; callers that expect specific fields treat
      // the miss as a caught failure, which is exactly what we want.
      res.end(JSON.stringify({
        success: true,
        data: {
          id: `stub-${Date.now()}`,
          virtualAccountId: `stub-va-${Date.now()}`,
          accountNumber: '0000000000',
          accountName: 'Wheelers Sandbox',
          bankName: 'Sandbox Bank',
          status: 'success',
        },
      }));
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    console.log(`[pouch-stub] listening on 127.0.0.1:${port}`);
    resolve(server);
  }));
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (invokedDirectly) {
  const { SANDBOX } = await import('./sandbox-env.mjs');
  await startPouchStub(SANDBOX.pouchStubPort);
}
