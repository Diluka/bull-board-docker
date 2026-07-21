interface RedisKeyClient {
  keys(pattern: string): Promise<string[]>;
}

interface ManagedQueue {
  name: string;
  close(): Promise<void>;
}

export interface QueueManagerOptions<QueueType extends ManagedQueue, AdapterType> {
  client: RedisKeyClient;
  prefix: string;
  version: string;
  createQueue(name: string): QueueType;
  createAdapter(queue: QueueType): AdapterType;
  onQueueCloseError?(queueName: string, error: unknown): void;
}

export class QueueManager<QueueType extends ManagedQueue, AdapterType> {
  readonly #client: RedisKeyClient;
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
    const keys = await this.#client.keys(`${this.#prefix}:*:${this.#suffix}`);
    const start = `${this.#prefix}:`;
    const end = `:${this.#suffix}`;
    const queueNames = Array.from(
      new Set(
        keys
          .filter((key) => key.startsWith(start) && key.endsWith(end))
          .map((key) => key.slice(start.length, -end.length)),
      ),
    ).sort();

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
