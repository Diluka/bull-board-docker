import assert from 'node:assert/strict';

const extensionBase = Deno.env.get('EXTENSION_BASE_URL') ?? 'http://nginx/app/bull-board';
const baselineBase = Deno.env.get('BASELINE_BASE_URL') ?? 'http://bull-board-baseline';
const login = Deno.env.get('TEST_USER_LOGIN') ?? 'test-user';
const password = Deno.env.get('TEST_USER_PASSWORD') ?? 'test-password';
const javascriptExample = `${extensionBase}/ext/example-js`;
const typescriptExample = `${extensionBase}/ext/example-ts`;

await waitUntilReachable(`${javascriptExample}/`);
await waitUntilReachable(`${typescriptExample}/`);
await waitUntilReachable(`${baselineBase}/`);

for (const base of [javascriptExample, typescriptExample]) {
  const unauthenticatedPage = await request(`${base}/`);
  assert.equal(unauthenticatedPage.status, 302);
  assert.equal(unauthenticatedPage.headers.get('location'), '/app/bull-board/login');
  const unauthenticatedApi = await request(`${base}/api/queues`);
  assert.equal(unauthenticatedApi.status, 302);
  assert.equal(unauthenticatedApi.headers.get('location'), '/app/bull-board/login');
}

const wrongLogin = await loginRequest('wrong-password');
assert.equal(wrongLogin.status, 302);
assert.equal(wrongLogin.headers.get('location'), '/app/bull-board/login');
for (const base of [javascriptExample, typescriptExample]) {
  const wrongPasswordExtension = await request(`${base}/`, cookieHeader(wrongLogin));
  assert.equal(wrongPasswordExtension.status, 302);
  assert.equal(wrongPasswordExtension.headers.get('location'), '/app/bull-board/login');
}

const correctLogin = await loginRequest(password);
assert.equal(correctLogin.status, 302);
assert.equal(correctLogin.headers.get('location'), '/app/bull-board/');
const cookie = cookieHeader(correctLogin);
assert.ok(cookie, 'successful login must set a session cookie');

const javascriptResponse = await request(`${javascriptExample}/`, cookie);
assert.equal(javascriptResponse.status, 200);
assert.equal(javascriptResponse.headers.get('content-type'), 'text/html; charset=utf-8');
const javascriptPage = await javascriptResponse.text();
assert.match(javascriptPage, /href=["']\.\/styles\.css["']/);
assert.match(javascriptPage, /src=["']\.\/app\.js["']/);

const javascriptScriptResponse = await request(`${javascriptExample}/app.js`, cookie);
assert.equal(javascriptScriptResponse.status, 200);
assert.equal(javascriptScriptResponse.headers.get('content-type'), 'text/javascript; charset=utf-8');
assert.match(await javascriptScriptResponse.text(), /fetch\(["']\.\/api\/queues["']\)/);

const typescriptResponse = await request(`${typescriptExample}/`, cookie);
assert.equal(typescriptResponse.status, 200);
assert.equal(typescriptResponse.headers.get('content-type'), 'text/html; charset=utf-8');
const typescriptPage = await typescriptResponse.text();
assert.match(typescriptPage, /href=["']\.\/styles\.css["']/);
assert.match(typescriptPage, /<script[^>]+type=["']module["'][^>]+src=["']\.\/app\.ts["']/);

const typescriptScriptResponse = await request(`${typescriptExample}/app.ts`, cookie);
assert.equal(typescriptScriptResponse.status, 200);
assert.equal(typescriptScriptResponse.headers.get('content-type'), 'text/javascript; charset=utf-8');
const typescriptScript = await typescriptScriptResponse.text();
assert.match(typescriptScript, /fetch\(["']\.\/api\/queues["']\)/);
assert.doesNotMatch(typescriptScript, /interface QueueSnapshot|name: string|: QueueSnapshot/);

const lazyTypescriptResponse = await request(`${typescriptExample}/queue-view.ts`, cookie);
assert.equal(lazyTypescriptResponse.status, 200);
assert.equal(lazyTypescriptResponse.headers.get('content-type'), 'text/javascript; charset=utf-8');
assert.match(await lazyTypescriptResponse.text(), /function renderQueues/);

for (const base of [javascriptExample, typescriptExample]) {
  const stylesheetResponse = await request(`${base}/styles.css`, cookie);
  assert.equal(stylesheetResponse.status, 200);
  assert.equal(stylesheetResponse.headers.get('content-type'), 'text/css; charset=utf-8');

  const queuesResponse = await request(`${base}/api/queues`, cookie);
  assert.equal(queuesResponse.status, 200);
  assert.deepEqual(await queuesResponse.json(), { queueCount: 1, queues: ['example'] });
}

const coreResponse = await request(`${extensionBase}/`, cookie);
assert.equal(coreResponse.status, 200);
const corePage = await coreResponse.text();
const uiConfigScript = corePage.match(/<script\b[^>]*\bid=(["'])__UI_CONFIG__\1[^>]*>([\s\S]*?)<\/script>/i);
assert.ok(uiConfigScript, 'Bull Board page must contain the __UI_CONFIG__ JSON script');
const uiConfig: unknown = JSON.parse(uiConfigScript[2]);
assert.ok(uiConfig !== null && typeof uiConfig === 'object', 'Bull Board UI config must be an object');
assert.deepEqual('miscLinks' in uiConfig ? uiConfig.miscLinks : undefined, [
  { text: 'JavaScript Example', url: '/app/bull-board/ext/example-js/' },
  { text: 'TypeScript Example', url: '/app/bull-board/ext/example-ts/' },
]);

const baselineResponse = await request(`${baselineBase}/`);
assert.equal(baselineResponse.status, 200);
assert.match(await baselineResponse.text(), /Bull Dashboard/i);

console.log('extension authentication, JavaScript and TypeScript pages, queue API, navigation, and baseline passed');

function request(url: string, cookie?: string): Promise<Response> {
  return fetch(url, {
    redirect: 'manual',
    headers: cookie ? { cookie } : undefined,
  });
}

function loginRequest(candidatePassword: string): Promise<Response> {
  return fetch(`${extensionBase}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: login, password: candidatePassword }),
  });
}

function cookieHeader(response: Response): string | undefined {
  return response.headers.get('set-cookie')?.split(';', 1)[0];
}

async function waitUntilReachable(url: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await request(url);
      if (response.status !== 502 && response.status !== 503) return;
      lastError = new Error(`received HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}: ${String(lastError)}`);
}
