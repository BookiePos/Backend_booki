import swc from 'unplugin-swc';
import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

// Ítem 5.8: pruebas de integración contra un Mongo real (mongodb-memory-server).
// Aparte del vitest normal (`pnpm test`) porque arrancan un mongod y son más
// lentas. Se corren con `pnpm test:integracion` y en el job `integracion` del CI.
// Los archivos son `*.integracion.ts` (no `.spec.ts`) para que `pnpm test` no
// los recoja.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.integracion.ts'],
    setupFiles: ['./src/integracion/preparar.ts'],
    testTimeout: 60_000,
    hookTimeout: 180_000, // la primera vez baja el binario de mongod
    fileParallelism: false,
  },
  plugins: [tsconfigPaths(), swc.vite({ module: { type: 'es6' } })],
});
