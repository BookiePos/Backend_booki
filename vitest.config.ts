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
  },
  plugins: [
    tsconfigPaths(),
    // SWC debe emitir metadata de decoradores (como tsc con
    // emitDecoratorMetadata) para que @nestjs/mongoose infiera el tipo de cada
    // @Prop() al importar los esquemas dentro de un test de servicio.
    swc.vite({ module: { type: 'es6' } }),
  ],
});
