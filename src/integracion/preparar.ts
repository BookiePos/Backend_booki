import 'reflect-metadata';
import { vi } from 'vitest';

/**
 * SWC emite `Object` como metadata de las uniones de literales
 * (`type: 'asset' | 'liability'`) y `@Prop` revienta («Cannot determine a type»);
 * tsc emite `String`, que es lo que corre en producción. Los esquemas que usan
 * estas pruebas solo tienen uniones de cadenas, así que si `@Prop` no puede
 * inferir el tipo se reintenta con `String`, igual que tsc.
 */
vi.mock('@nestjs/mongoose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nestjs/mongoose')>();
  return {
    ...actual,
    Prop: (options?: Record<string, unknown>) => (target: object, key: string | symbol) => {
      try {
        actual.Prop(options as never)(target, key as string);
      } catch {
        actual.Prop({ ...(options ?? {}), type: String } as never)(target, key as string);
      }
    },
  };
});
