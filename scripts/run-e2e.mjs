import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import './seed-e2e.mjs';

// Run the Playwright CLI with Node directly so arguments are passed without shell interpolation.
const playwrightCli = createRequire(import.meta.url).resolve('@playwright/test/cli');

const code = await new Promise((resolve) => {
  const child = spawn(process.execPath, [playwrightCli, 'test', ...process.argv.slice(2)], { stdio: 'inherit' });
  child.once('exit', (exitCode) => resolve(exitCode ?? 1)).once('error', () => resolve(1));
});
process.exit(code);
