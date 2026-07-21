import assert from 'node:assert/strict';

Deno.test('acceptance requires the exact queue API JSON', async () => {
  const exact = await runAcceptanceFixture({
    queuePayload: { queueCount: 1, queues: ['example'] },
    miscLinks: [{ text: 'Example', url: '/app/bull-board/ext/example/' }],
  });
  assert.equal(exact.success, true, new TextDecoder().decode(exact.stderr));

  const wrongCount = await runAcceptanceFixture({
    queuePayload: { queueCount: 10, queues: ['example'] },
    miscLinks: [{ text: 'Example', url: '/app/bull-board/ext/example/' }],
  });
  assert.equal(wrongCount.success, false, 'queue count 10 must not satisfy the exact count 1 contract');
  assert.match(new TextDecoder().decode(wrongCount.stderr), /queueCount/);
});

Deno.test('acceptance requires exactly the Example navigation link from UI config', async () => {
  const exact = await runAcceptanceFixture({
    queuePayload: { queueCount: 1, queues: ['example'] },
    miscLinks: [{ text: 'Example', url: '/app/bull-board/ext/example/' }],
  });
  assert.equal(exact.success, true, new TextDecoder().decode(exact.stderr));

  const wrongAndExtra = await runAcceptanceFixture({
    queuePayload: { queueCount: 1, queues: ['example'] },
    miscLinks: [
      { text: 'Not Example', url: '/app/bull-board/ext/example/' },
      { text: 'Extra', url: '/extra/' },
    ],
  });
  assert.equal(wrongAndExtra.success, false, 'wrong text and an extra link must not satisfy the exact navigation contract');
  assert.match(new TextDecoder().decode(wrongAndExtra.stderr), /Not Example/);
});

interface AcceptanceFixture {
  queuePayload: unknown;
  miscLinks: unknown[];
}

async function runAcceptanceFixture(fixture: AcceptanceFixture): Promise<Deno.CommandOutput> {
  const extension = await startServer((request) => extensionResponse(request, fixture));
  const baseline = await startServer(() => new Response('<title>Bull Dashboard</title>'));
  try {
    return await new Deno.Command(Deno.execPath(), {
      args: ['run', '--allow-env', '--allow-net', '--frozen', '--node-modules-dir=none', 'test/acceptance.ts'],
      env: {
        ...Deno.env.toObject(),
        EXTENSION_BASE_URL: extension.url,
        BASELINE_BASE_URL: baseline.url,
      },
      stdout: 'piped',
      stderr: 'piped',
    }).output();
  } finally {
    await Promise.all([extension.shutdown(), baseline.shutdown()]);
  }
}

async function extensionResponse(request: Request, fixture: AcceptanceFixture): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/login' && request.method === 'POST') {
    const password = new URLSearchParams(await request.text()).get('password');
    return password === 'test-password'
      ? redirect('/app/bull-board/', { 'set-cookie': 'session=valid; Path=/' })
      : redirect('/app/bull-board/login');
  }
  if (url.pathname.startsWith('/ext/example/') && request.headers.get('cookie') !== 'session=valid') {
    return redirect('/app/bull-board/login');
  }
  if (url.pathname === '/ext/example/') {
    return new Response(
      '<link rel="stylesheet" href="./styles.css"><script src="./app.js"></script>',
      { headers: { 'content-type': 'text/html; charset=utf-8' } },
    );
  }
  if (url.pathname === '/ext/example/app.js') {
    return new Response("fetch('./api/queues')", { headers: { 'content-type': 'text/javascript; charset=utf-8' } });
  }
  if (url.pathname === '/ext/example/styles.css') {
    return new Response('body {}', { headers: { 'content-type': 'text/css; charset=utf-8' } });
  }
  if (url.pathname === '/ext/example/api/queues') {
    return Response.json(fixture.queuePayload);
  }
  if (url.pathname === '/') {
    const config = JSON.stringify({ miscLinks: fixture.miscLinks });
    return new Response(`<script id="__UI_CONFIG__" type="application/json">${config}</script>`);
  }
  return new Response('not found', { status: 404 });
}

function redirect(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 302, headers: { ...headers, location } });
}

interface TestServer {
  url: string;
  shutdown(): Promise<void>;
}

async function startServer(handler: (request: Request) => Response | Promise<Response>): Promise<TestServer> {
  let ready!: (port: number) => void;
  const port = new Promise<number>((resolve) => ready = resolve);
  const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: (address) => ready(address.port) }, handler);
  return {
    url: `http://127.0.0.1:${await port}`,
    shutdown: () => server.shutdown(),
  };
}
