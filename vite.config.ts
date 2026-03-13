import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

type RuntimeEnv = Record<string, string | undefined>;

function resolveBase(command: string): string {
  const runtimeEnv =
    (globalThis as typeof globalThis & { process?: { env?: RuntimeEnv } }).process?.env ?? {};

  if (runtimeEnv.VITE_BASE_PATH) {
    return runtimeEnv.VITE_BASE_PATH;
  }

  return command === 'build' ? './' : '/';
}

export default defineConfig(({ command }) => ({
  base: resolveBase(command),
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.ts']
  }
}));
