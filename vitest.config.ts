import swc from 'unplugin-swc';
import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

// Vitest + SWC: SWC compila los decoradores de NestJS (@Injectable/@InjectModel)
// con emitDecoratorMetadata, igual que tsc. Los tests instancian servicios con
// dependencias mockeadas (sin DI de Nest ni Mongo real), así que son unitarios y
// deterministas.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    setupFiles: ['reflect-metadata'],
    // Ítem 5.1: `pnpm test:cobertura` y el gate de vitest la miden. Solo el
    // código de producción: specs, semillas y scripts de datos no cuentan.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/integracion/**', 'src/seed/**', 'src/datos/**', 'src/main.ts'],
    },
  },
  plugins: [
    tsconfigPaths(),
    // SWC debe emitir metadata de decoradores (como tsc con
    // emitDecoratorMetadata) para que @nestjs/mongoose infiera el tipo de cada
    // @Prop() al importar los esquemas dentro de un test de servicio.
    swc.vite({ module: { type: 'es6' } }),
  ],
});
