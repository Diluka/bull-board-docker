import { Queue } from 'bullmq';

const queue = new Queue('example', {
  connection: {
    host: Deno.env.get('REDIS_HOST') ?? 'redis',
    port: Number(Deno.env.get('REDIS_PORT') ?? '6379'),
  },
});

try {
  await queue.add('acceptance', {}, { jobId: 'acceptance' });
  console.log('created BullMQ queue "example"');
} finally {
  await queue.close();
}
