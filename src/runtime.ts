import type { Server } from 'node:http';

export interface RefreshSchedulerOptions<AdapterType> {
  refresh(): Promise<readonly AdapterType[]>;
  replaceQueues(queues: readonly AdapterType[]): void;
  onError(error: unknown): void;
  intervalMs?: number;
  setInterval?: (callback: () => void, intervalMs: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

export interface RefreshScheduler {
  start(): void;
  refreshNow(): Promise<void>;
  stop(): Promise<void>;
}

export function createRefreshScheduler<AdapterType>(options: RefreshSchedulerOptions<AdapterType>): RefreshScheduler {
  const schedule = options.setInterval ?? ((callback, intervalMs) => setInterval(callback, intervalMs));
  const clearSchedule = options.clearInterval ?? ((handle) => clearInterval(handle as number));
  let interval: unknown;
  let inFlight: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let stopped = false;

  const refreshNow = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;

    const task = options.refresh().then((queues) => options.replaceQueues(queues));
    inFlight = task;
    const clear = () => {
      if (inFlight === task) inFlight = undefined;
    };
    void task.then(clear, clear);
    return task;
  };

  return {
    start() {
      if (interval !== undefined || stopped) return;
      interval = schedule(() => {
        void refreshNow().catch(options.onError);
      }, options.intervalMs ?? 60_000);
    },
    refreshNow,
    stop() {
      if (stopPromise) return stopPromise;
      stopped = true;
      if (interval !== undefined) {
        clearSchedule(interval);
        interval = undefined;
      }
      const active = inFlight;
      stopPromise = active ? active.catch(() => {}) : Promise.resolve();
      return stopPromise;
    },
  };
}

export type ShutdownStage = 'refresh' | 'server' | 'extensions' | 'queues' | 'redis';

export interface ShutdownOptions {
  stopRefresh(): Promise<void>;
  closeServer(): Promise<void>;
  disposeExtensions(): Promise<void>;
  closeQueues(): Promise<void>;
  disconnectRedis(): Promise<void>;
  onError(stage: ShutdownStage, error: unknown): void;
}

export function createShutdown(options: ShutdownOptions): () => Promise<void> {
  let shutdownPromise: Promise<void> | undefined;
  return () => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      const stages: readonly [ShutdownStage, () => Promise<void>][] = [
        ['refresh', options.stopRefresh],
        ['server', options.closeServer],
        ['extensions', options.disposeExtensions],
        ['queues', options.closeQueues],
        ['redis', options.disconnectRedis],
      ];
      for (const [stage, action] of stages) {
        try {
          await action();
        } catch (error) {
          options.onError(stage, error);
        }
      }
    })();
    return shutdownPromise;
  };
}
