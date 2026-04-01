import { disconnectDlq } from './dlq';

type ShutdownFn = () => Promise<void>;

const handlers: ShutdownFn[] = [];
let   shuttingDown            = false;

// Register a cleanup function to run on process exit.
// Call once per producer/consumer in your service's index.ts:
//
//   onShutdown(() => producer.disconnect());
//   onShutdown(() => consumer.disconnect());
export function onShutdown(fn: ShutdownFn): void {
  handlers.push(fn);
}

// Wire up SIGTERM and SIGINT listeners.
// Call once at the top of each service's index.ts.
//
//   registerShutdownHandlers('ride-service');
export function registerShutdownHandlers(serviceName: string): void {
  const handle = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`[${serviceName}] ${signal} received — shutting down...`);

    // Always clean up DLQ producer last
    handlers.push(disconnectDlq);

    for (const fn of handlers) {
      try {
        await fn();
      } catch (err) {
        console.error(
          `[${serviceName}] Shutdown handler error: `,
          err instanceof Error ? err.message : err,
        );
      }
    }

    console.log(`[${serviceName}] Shutdown complete.`);
    process.exit(0);
  };

  process.on('SIGTERM', () => { void handle('SIGTERM'); });
  process.on('SIGINT',  () => { void handle('SIGINT');  });

  process.on('unhandledRejection', (reason) => {
    console.error(`[${serviceName}] Unhandled rejection:`, reason);
  });
}