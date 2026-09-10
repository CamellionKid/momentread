import {defineConfig} from 'vitest/config';
export default defineConfig({test:{include:['tests/**/*.test.ts','tests/**/*.test.tsx'],testTimeout:15000,exclude:['prototype/**','node_modules/**'],maxWorkers:3}});
