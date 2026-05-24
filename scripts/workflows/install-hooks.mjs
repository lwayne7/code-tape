import { execFileSync } from 'node:child_process';

if (process.env.CI) {
  console.log('Skipping git hook installation in CI.');
  process.exit(0);
}

try {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'inherit' });
  console.log('Git hooks installed via core.hooksPath=.githooks');
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  throw new Error(`failed to install git hooks: ${message}`);
}
