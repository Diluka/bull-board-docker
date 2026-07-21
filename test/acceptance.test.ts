import assert from 'node:assert/strict';

Deno.test('acceptance rejects a queue count of 10 instead of matching its leading 1', async () => {
  const result = await runAcceptanceFixture({
    extensionPage: '<p>Queue count: 10</p><ul><li>example</li></ul>',
    miscLinks: [{ text: 'Example', url: '/app/bull-board/ext/example/' }],
  });

  assert.equal(result.success, false, 'queue count 10 must not satisfy the exact count 1 contract');
  assert.match(new TextDecoder().decode(result.stderr), /Queue count: 1/);
});

Deno.test('acceptance requires exactly the Example navigation link from UI config', async () => {
  const exact = await runAcceptanceFixture({
    extensionPage: '<p>Queue count: 1</p><ul><li>example</li></ul>',
    miscLinks: [{ text: 'Example', url: '/app/bull-board/ext/example/' }],
  });
  assert.equal(exact.success, true, new TextDecoder().decode(exact.stderr));

  const wrongAndExtra = await runAcceptanceFixture({
    extensionPage: '<p>Queue count: 1</p><ul><li>example</li></ul>',
    miscLinks: [
      { text: 'Not Example', url: '/app/bull-board/ext/example/' },
      { text: 'Extra', url: '/extra/' },
    ],
  });
  assert.equal(wrongAndExtra.success, false, 'wrong text and an extra link must not satisfy the exact navigation contract');
  assert.match(new TextDecoder().decode(wrongAndExtra.stderr), /Not Example/);
});

interface AcceptanceFixture {
  extensionPage: string;
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
  if (url.pathname === '/ext/example/') {
    return request.headers.get('cookie') === 'session=valid' ? new Response(fixture.extensionPage) : redirect('/app/bull-board/login');
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
