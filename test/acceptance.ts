import assert from 'node:assert/strict';

const extensionBase = Deno.env.get('EXTENSION_BASE_URL') ?? 'http://nginx/app/bull-board';
const baselineBase = Deno.env.get('BASELINE_BASE_URL') ?? 'http://bull-board-baseline';
const login = Deno.env.get('TEST_USER_LOGIN') ?? 'test-user';
const password = Deno.env.get('TEST_USER_PASSWORD') ?? 'test-password';

await waitUntilReachable(`${extensionBase}/ext/example/`);
await waitUntilReachable(`${baselineBase}/`);

const unauthenticated = await request(`${extensionBase}/ext/example/`);
assert.equal(unauthenticated.status, 302);
assert.equal(unauthenticated.headers.get('location'), '/app/bull-board/login');

const wrongLogin = await loginRequest('wrong-password');
assert.equal(wrongLogin.status, 302);
assert.equal(wrongLogin.headers.get('location'), '/app/bull-board/login');
const wrongPasswordExtension = await request(`${extensionBase}/ext/example/`, cookieHeader(wrongLogin));
assert.equal(wrongPasswordExtension.status, 302);
assert.equal(wrongPasswordExtension.headers.get('location'), '/app/bull-board/login');

const correctLogin = await loginRequest(password);
assert.equal(correctLogin.status, 302);
assert.equal(correctLogin.headers.get('location'), '/app/bull-board/');
const cookie = cookieHeader(correctLogin);
assert.ok(cookie, 'successful login must set a session cookie');

const extensionResponse = await request(`${extensionBase}/ext/example/`, cookie);
assert.equal(extensionResponse.status, 200);
const extensionPage = await extensionResponse.text();
assert.match(extensionPage, /Queue count:\s*1/);
assert.equal((extensionPage.match(/<li>example<\/li>/g) ?? []).length, 1);

const coreResponse = await request(`${extensionBase}/`, cookie);
assert.equal(coreResponse.status, 200);
const corePage = await coreResponse.text();
assert.ok(corePage.includes('/app/bull-board/ext/example/'), 'Bull Board navigation must contain the extension href');

const baselineResponse = await request(`${baselineBase}/`);
assert.equal(baselineResponse.status, 200);
assert.match(await baselineResponse.text(), /Bull Dashboard/i);

console.log('extension authentication, queue page, navigation, and no-extension baseline passed');

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
