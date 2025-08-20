// Real dependencies for Deno runtime using npm: specifiers
// These are the actual Bull Board and Redis packages

// Bull Board API and adapters  
export { createBullBoard } from "npm:@bull-board/api@6.10.0";
export { BullAdapter } from "npm:@bull-board/api@6.10.0/bullAdapter.js";
export { BullMQAdapter } from "npm:@bull-board/api@6.10.0/bullMQAdapter.js";
export { ExpressAdapter } from "npm:@bull-board/express@6.10.0";

// Queue libraries
export { default as Bull } from "npm:bull@4.16.5";
export { Queue } from "npm:bullmq@5.53.2";

// Redis client
export { default as IORedis } from "npm:ioredis@5.6.1";

// Express and auth
export { default as express } from "npm:express@5.1.0";
export { default as session } from "npm:express-session@1.18.1";
export { default as passport } from "npm:passport@0.7.0";
export { Strategy as LocalStrategy } from "npm:passport-local@1.0.0";

// Deno HTTP server wrapper
export function serve(handler: (req: Request) => Promise<Response>, options: { port: number }) {
  return Deno.serve(options, handler);
}

// Path utilities using Deno standard library
export { join, dirname } from "https://deno.land/std@0.208.0/path/mod.ts";