import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'jsdom', include: ['mobile-client/**/*.test.{ts,tsx}'] } });
