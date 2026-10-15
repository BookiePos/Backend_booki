import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import { JournalEntrySchema } from './journal-entry.schema';
import {
  INDICE_ORIGEN_VIVO,
  INDICE_UNA_REVERSA,
} from '../../domain/journal-entry.indices';

/**
 * El libro no puede tener dos asientos vivos del mismo evento (checklist 1.13):
 * una venta contabilizada dos veces duplica ingreso, IVA y caja sin que nada lo
 * delate. Este spec fija que el esquema real declara los índices únicos, con su
 * filtro parcial: sin el filtro, el contra-asiento (mismo sourceId) o el
 * reposteo de un gasto editado chocarían con el original.
 */
describe('JournalEntrySchema · índices únicos', () => {
  const indices = JournalEntrySchema.indexes() as [
    Record<string, number>,
    Record<string, unknown>,
  ][];
  const porNombre = (nombre: string) => indices.find(([, o]) => o.name === nombre);

  it('declara (sourceType, sourceId) único solo entre asientos originales vivos', () => {
    const idx = porNombre('origen_vivo_unico');
    expect(idx).toBeDefined();
    expect(idx![0]).toEqual({ sourceType: 1, sourceId: 1 });
    expect(idx![1]).toMatchObject({
      unique: true,
      partialFilterExpression: {
        sourceId: { $type: 'string' },
        reversalOf: { $type: 'null' },
        reversedBy: { $type: 'null' },
      },
    });
    expect(idx![1].partialFilterExpression).toEqual(
      INDICE_ORIGEN_VIVO.options.partialFilterExpression,
    );
  });

  it('declara un solo contra-asiento por asiento', () => {
    const idx = porNombre('una_reversa_por_asiento');
    expect(idx).toBeDefined();
    expect(idx![0]).toEqual({ reversalOf: 1 });
    expect(idx![1]).toMatchObject({
      unique: true,
      partialFilterExpression: INDICE_UNA_REVERSA.options.partialFilterExpression,
    });
  });

  it('ningún otro índice sobre el origen es único (no rompería reversas ni reposteos)', () => {
    const otros = indices.filter(
      ([k, o]) => 'sourceType' in k && o.name !== 'origen_vivo_unico',
    );
    expect(otros.length).toBeGreaterThan(0);
    for (const [, o] of otros) expect(o.unique).not.toBe(true);
  });

  it('si Mongo no puede crear los índices (p. ej. por duplicados), queda un error en el log', () => {
    // Mongoose crea los índices al compilar el modelo de cada empresa y, si
    // falla, lo calla: el libro seguiría sin su garantía sin que nadie lo sepa.
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const modelo = Object.assign(new EventEmitter(), { db: { name: 'biz_123' } });
    JournalEntrySchema.emit('init', modelo);

    modelo.emit('index', Object.assign(new Error('E11000 duplicate key'), { code: 11000 }));

    expect(error).toHaveBeenCalledOnce();
    const msg = String(error.mock.calls[0]![0]);
    expect(msg).toContain('biz_123');
    expect(msg).toContain('E11000');
    modelo.emit('index', undefined); // sin error no registra nada
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });
});
