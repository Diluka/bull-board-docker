export interface BundleProcessOutput {
  readonly success: boolean;
  readonly code: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

export interface BrowserTypeScriptBundlerDependencies {
  execPath?(): string;
  execute?(executable: string, args: readonly string[]): Promise<BundleProcessOutput>;
}

const decoder = new TextDecoder();

export async function bundleBrowserTypeScript(
  entry: URL,
  dependencies: BrowserTypeScriptBundlerDependencies = {},
): Promise<string> {
  const args = [
    'bundle',
    '--no-config',
    '--no-lock',
    '--platform',
    'browser',
    '--format',
    'esm',
    '--allow-import',
    entry.href,
  ] as const;
  const output = await (dependencies.execute ?? execute)(dependencies.execPath?.() ?? Deno.execPath(), args);
  if (!output.success) {
    const detail = decoder.decode(output.stderr).trim() || 'no error output';
    throw new Error(`Unable to bundle TypeScript page "${entry.href}" (exit code ${output.code}): ${detail}`);
  }
  return decoder.decode(output.stdout);
}

async function execute(executable: string, args: readonly string[]): Promise<BundleProcessOutput> {
  return await new Deno.Command(executable, {
    args: [...args],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
}
