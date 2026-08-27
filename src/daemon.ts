import type { AppConfig } from "./config.ts";
import { createHttpHandler } from "./server.ts";
import { AttentionStore } from "./store.ts";

export interface RunningDaemon {
  url: string;
  store: AttentionStore;
  stop(): Promise<void>;
}

export function startDaemon(config: AppConfig): RunningDaemon {
  const store = new AttentionStore(config.database);
  const handler = createHttpHandler({ store, config });
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: config.server.host,
      port: config.server.port,
      fetch: handler,
    });
  } catch (error) {
    store.close();
    throw error;
  }
  const sweeper = setInterval(() => {
    try {
      store.sweepExpired();
    } catch (error) {
      console.error("Expiry sweep failed", error);
    }
  }, 1_000);
  sweeper.unref();
  return {
    url: server.url.toString().replace(/\/$/, ""),
    store,
    async stop() {
      clearInterval(sweeper);
      await server.stop(true);
      store.close();
    },
  };
}
