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
}

export class QueueManager<QueueType extends ManagedQueue, AdapterType> {
  readonly #client: RedisKeyClient;
  readonly #prefix: string;
  readonly #suffix: string;
  readonly #createQueue: (name: string) => QueueType;
  readonly #createAdapter: (queue: QueueType) => AdapterType;
  #queues = new Map<string, QueueType>();
  #refreshPromise: Promise<readonly AdapterType[]> | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(options: QueueManagerOptions<QueueType, AdapterType>) {
    this.#client = options.client;
    this.#prefix = options.prefix;
    this.#suffix = options.version === 'BULLMQ' ? 'meta' : 'id';
    this.#createQueue = options.createQueue;
    this.#createAdapter = options.createAdapter;
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

    for (const queueName of queueNames) {
      if (!this.#queues.has(queueName)) this.#queues.set(queueName, this.#createQueue(queueName));
    }

    for (const [queueName, queue] of this.#queues) {
      if (!queueNames.includes(queueName)) {
        await queue.close();
        this.#queues.delete(queueName);
      }
    }

    this.#queues = new Map(queueNames.map((queueName) => [queueName, this.#queues.get(queueName)!]));
    return queueNames.map((queueName) => this.#createAdapter(this.#queues.get(queueName)!));
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
    for (const queue of this.#queues.values()) {
      try {
        await queue.close();
      } catch (error) {
        errors.push(error);
      }
    }
    this.#queues.clear();
    if (errors.length > 0) throw new AggregateError(errors, 'Failed to close queues');
  }
}
