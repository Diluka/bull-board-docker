interface RedisScanClient {
  scan(cursor: string, match: 'MATCH', pattern: string, count: 'COUNT', size: number): Promise<[string, string[]]>;
}

interface RedisClusterClient {
  ping(): Promise<string>;
  nodes(role: 'master'): RedisScanClient[];
}

interface ManagedQueue {
  name: string;
  close(): Promise<void>;
}

export interface QueueManagerOptions<QueueType extends ManagedQueue, AdapterType> {
  client: RedisScanClient | RedisClusterClient;
  prefix: string;
  version: string;
  createQueue(name: string): QueueType;
  createAdapter(queue: QueueType): AdapterType;
  onQueueCloseError?(queueName: string, error: unknown): void;
}

export class QueueManager<QueueType extends ManagedQueue, AdapterType> {
  readonly #client: RedisScanClient | RedisClusterClient;
  readonly #prefix: string;
  readonly #suffix: string;
  readonly #createQueue: (name: string) => QueueType;
  readonly #createAdapter: (queue: QueueType) => AdapterType;
  readonly #onQueueCloseError: (queueName: string, error: unknown) => void;
  #queues = new Map<string, QueueType>();
  #pendingClose = new Set<QueueType>();
  #refreshPromise: Promise<readonly AdapterType[]> | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(options: QueueManagerOptions<QueueType, AdapterType>) {
    this.#client = options.client;
    this.#prefix = options.prefix;
    this.#suffix = options.version === 'BULLMQ' ? 'meta' : 'id';
    this.#createQueue = options.createQueue;
    this.#createAdapter = options.createAdapter;
    this.#onQueueCloseError = options.onQueueCloseError ?? (() => {});
  }

  list(): readonly QueueType[] {
    return Array.from(this.#queues.values());
  }

  get(name: string): QueueType | undefined {
    return this.#queues.get(name);
  }

  refresh(): Promise<readonly AdapterType[]> {
    if (this.#closePromise) return Promise.reject(new Error('QueueManager is closed'));
    if (this.#refreshPromise) return this.#refreshPromise;

    const task = this.#runRefresh();
    this.#refreshPromise = task;
    const clear = () => {
      if (this.#refreshPromise === task) this.#refreshPromise = undefined;
    };
    void task.then(clear, clear);
    return task;
  }

  close(): Promise<void> {
    if (!this.#closePromise) this.#closePromise = this.#runClose();
    return this.#closePromise;
  }

  async #runRefresh(): Promise<readonly AdapterType[]> {
    const queueNames = await this.#discoverQueueNames();

    const nextQueues = new Map<string, QueueType>();
    const createdQueues: QueueType[] = [];
    let adapters: readonly AdapterType[];
    try {
      for (const queueName of queueNames) {
        let queue = this.#queues.get(queueName);
        if (!queue) {
          queue = this.#createQueue(queueName);
          createdQueues.push(queue);
        }
        nextQueues.set(queueName, queue);
      }
      adapters = queueNames.map((queueName) => this.#createAdapter(nextQueues.get(queueName)!));
    } catch (error) {
      await this.#cleanupFailedSnapshot(createdQueues, error);
      throw error;
    }

    for (const [queueName, queue] of this.#queues) {
      if (!nextQueues.has(queueName)) this.#pendingClose.add(queue);
    }
    this.#queues = nextQueues;
    await this.#drainPendingClose();
    return adapters;
  }

  async #discoverQueueNames(): Promise<string[]> {
    let clients: RedisScanClient[];
    if ('nodes' in this.#client) {
      await this.#client.ping();
      clients = this.#client.nodes('master');
      if (clients.length === 0) throw new Error('No Redis Cluster masters available for queue discovery');
    } else {
      clients = [this.#client];
    }

    const start = `${this.#prefix}:`;
    const end = `:${this.#suffix}`;
    const queueNames = new Set<string>();
    for (const client of clients) {
      let cursor = '0';
      do {
        const [nextCursor, keys] = await client.scan(cursor, 'MATCH', `${start}*${end}`, 'COUNT', 500);
        for (const key of keys) {
          if (key.startsWith(start) && key.endsWith(end)) queueNames.add(key.slice(start.length, -end.length));
        }
        cursor = nextCursor;
      } while (cursor !== '0');
    }
    return Array.from(queueNames).sort();
  }

  async #cleanupFailedSnapshot(createdQueues: readonly QueueType[], cause: unknown): Promise<never> {
    const cleanupErrors: unknown[] = [];
    for (const queue of createdQueues) {
      try {
        await queue.close();
      } catch (error) {
        cleanupErrors.push(error);
        this.#pendingClose.add(queue);
        this.#reportQueueCloseError(queue.name, error);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([cause, ...cleanupErrors], 'Failed to prepare queue snapshot and clean up new queues');
    }
    throw cause;
  }

  async #drainPendingClose(): Promise<void> {
    for (const queue of this.#pendingClose) {
      try {
        await queue.close();
        this.#pendingClose.delete(queue);
      } catch (error) {
        this.#reportQueueCloseError(queue.name, error);
      }
    }
  }

  #reportQueueCloseError(queueName: string, error: unknown): void {
    try {
      this.#onQueueCloseError(queueName, error);
    } catch {
      // A reporting callback must not make queue refresh fail.
    }
  }

  async #runClose(): Promise<void> {
    if (this.#refreshPromise) {
      try {
        await this.#refreshPromise;
      } catch {
        // Queue cleanup must still run after a failed refresh.
      }
    }

    const errors: unknown[] = [];
    const queues = new Set([...this.#queues.values(), ...this.#pendingClose]);
    for (const queue of queues) {
      try {
        await queue.close();
      } catch (error) {
        errors.push(error);
        this.#reportQueueCloseError(queue.name, error);
      }
    }
    this.#queues.clear();
    this.#pendingClose.clear();
    if (errors.length > 0) throw new AggregateError(errors, 'Failed to close queues');
  }
}
