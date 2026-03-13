import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

type RuntimeEnv = Record<string, string | undefined>;

function resolveBase(): string {
  const runtimeEnv =
    (globalThis as typeof globalThis & { process?: { env?: RuntimeEnv } }).process?.env ?? {};

  if (runtimeEnv.VITE_BASE_PATH) {
    return runtimeEnv.VITE_BASE_PATH;
  }

  if (runtimeEnv.GITHUB_ACTIONS === 'true') {
    const [owner, repo] = (runtimeEnv.GITHUB_REPOSITORY ?? '').split('/');
    if (repo && owner && repo.toLowerCase() === `${owner.toLowerCase()}.github.io`) {
      return '/';
    }

    if (repo) {
      return `/${repo}/`;
    }
  }

  return '/';
}

export default defineConfig({
  base: resolveBase(),
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.ts']
  }
});
