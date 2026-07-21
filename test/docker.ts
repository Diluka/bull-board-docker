import assert from 'node:assert/strict';

const composeFile = 'docker-compose.test.yml';

try {
  await compose(['down', '--volumes', '--remove-orphans']);
  await compose(['build', 'bull-board']);
  await compose([
    'run',
    '--rm',
    '--no-deps',
    '--entrypoint',
    'sh',
    'bull-board',
    '-c',
    'test ! -e /usr/app/extensions',
  ]);
  await compose([
    'run',
    '--rm',
    '--no-deps',
    '--entrypoint',
    'deno',
    'bull-board',
    'check',
    '--frozen',
    '--config=/usr/app/deno.json',
    '/extensions/example-js/mod.ts',
    '/extensions/example-ts/mod.ts',
    '/extensions/example-ts/public/app.ts',
  ]);
  await compose(['up', '-d', 'bull-board', 'bull-board-baseline']);
  await compose(['run', '--rm', '--no-deps', 'acceptance']);

  const invalid = await compose(['run', '--rm', '--no-deps', 'invalid-extension'], false);
  assert.notEqual(invalid.code, 0, 'invalid extension startup must exit non-zero');
  assert.match(invalid.output, /Extension at index 0 \(\/extensions\/missing\) failed to resolve/);
  assert.doesNotMatch(invalid.output, /bull-board is started/, 'invalid extension startup must fail before HTTP listening');
  console.log('invalid extension failed before HTTP listening with index and specifier diagnostics');

  const invalidTypeScript = await compose(['run', '--rm', '--no-deps', 'invalid-typescript-extension'], false);
  assert.notEqual(invalidTypeScript.code, 0, 'preloaded TypeScript compilation failure must exit non-zero');
  assert.match(
    invalidTypeScript.output,
    /Extension at index 0 \(\/extensions\/invalid-typescript\) with id "invalid-typescript" failed to preload pages/,
  );
  assert.match(invalidTypeScript.output, /Unable to bundle TypeScript page .*app\.ts/);
  assert.doesNotMatch(invalidTypeScript.output, /bull-board is started/, 'TypeScript preload failure must happen before HTTP listening');
  console.log('invalid preloaded TypeScript failed before HTTP listening with bundle diagnostics');
} finally {
  await compose(['down', '--volumes', '--remove-orphans']);
}

interface CommandResult {
  code: number;
  output: string;
}

async function compose(args: string[], requireSuccess = true): Promise<CommandResult> {
  console.log(`docker compose ${args.join(' ')}`);
  const result = await new Deno.Command('docker', {
    args: ['compose', '-f', composeFile, ...args],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  if (stdout) console.log(stdout.trimEnd());
  if (stderr) console.error(stderr.trimEnd());
  const output = `${stdout}\n${stderr}`;
  if (requireSuccess && !result.success) {
    throw new Error(`docker compose ${args.join(' ')} exited with code ${result.code}`);
  }
  return { code: result.code, output };
}
