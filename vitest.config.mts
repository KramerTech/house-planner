import { defineConfig } from 'vitest/config';

// Unit tests for framework-free logic (geometry, constraints, building model).
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    globals: true,
  },
});
