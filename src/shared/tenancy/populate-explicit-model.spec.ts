import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

/**
 * Guardia del bug multi-empresa más caro que hemos tenido: `populate` por
 * NOMBRE de modelo.
 *
 * Cada empresa vive en su propia base y sus modelos se compilan de forma
 * perezosa sobre esa conexión. Cuando `populate` resuelve la referencia por
 * nombre ("User", "Product", "Sede"…), mongoose exige que ese modelo YA esté
 * compilado en la base de la empresa activa; si la petición que llega primero
 * es justo la que puebla, revienta con MissingSchemaError y el módulo sale en
 * 500. Refrescar lo "arreglaba" porque para entonces otra petición ya lo había
 * compilado, y volvía a fallar tras cada reinicio del servidor.
 *
 * Pasar el modelo inyectado (`model: this.xModel`) quita la dependencia del
 * orden. Esta prueba recorre el código y falla si alguien vuelve a la forma
 * corta, porque el fallo NO se ve en desarrollo una vez la base está caliente.
 */
describe('populate multi-empresa', () => {
  /** Todos los .ts de producción bajo src (sin pruebas ni definiciones). */
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return sourceFiles(full);
      if (!entry.endsWith('.ts')) return [];
      if (entry.endsWith('.spec.ts') || entry.endsWith('.d.ts')) return [];
      return [full];
    });
  }

  const SRC = join(__dirname, '..', '..');

  it('ningún populate resuelve la referencia por nombre', () => {
    // `.populate('camino', ...)` — la forma corta, que resuelve por el `ref`
    // del esquema. La forma con objeto debe llevar siempre `model:`.
    const shortForm = /\.populate\(\s*['"`]/;
    const offenders = sourceFiles(SRC)
      .filter((file) => shortForm.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(SRC.length + 1).split(sep).join('/'));

    expect(offenders).toEqual([]);
  });

  it('todo populate con objeto declara el modelo explícito', () => {
    // Se mira cada literal `{ path: … }` que abre un populate y se comprueba
    // que el mismo objeto trae `model:` antes del siguiente `path:`.
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      const blocks = text.split(/\.populate\(\s*\{/).slice(1);
      for (const block of blocks) {
        // Recorta en el siguiente populate anidado para no leer su `model:`.
        const scope = block.split(/populate:\s*\{/)[0] ?? '';
        if (!/\bmodel\s*:/.test(scope)) {
          offenders.push(file.slice(SRC.length + 1).split(sep).join('/'));
          break;
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
