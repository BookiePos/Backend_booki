import { describe, expect, it } from 'vitest';
import { nitEnmascarado, planificarEmisores } from './emisores-desde-sedes';

const base = {
  name: 'Sede',
  businessName: 'Crunchy SAS',
  nitDv: '7',
  tipoPersona: 'juridica',
  responsableIva: true,
  address: 'Cra 1',
};

describe('planificarEmisores', () => {
  it('un emisor por NIT normalizado; dos sedes del mismo NIT lo comparten', () => {
    const plan = planificarEmisores(
      [
        { ...base, id: 's1', nit: '900.123.456-7' },
        { ...base, id: 's2', nit: '900123456' },
        { ...base, id: 's3', nit: '800111222', businessName: 'Otra' },
      ],
      [],
    );
    expect(plan.crear.map((c) => [c.nitNorm, c.sedeIds])).toEqual([
      ['900123456', ['s1', 's2']],
      ['800111222', ['s3']],
    ]);
    expect(plan.conflictos).toEqual([]);
  });

  it('las sedes sin NIT se cuentan y no reciben emisor', () => {
    const plan = planificarEmisores([{ ...base, id: 's1' }, { ...base, id: 's2', nit: ' ' }], []);
    expect(plan.sedesSinNit).toEqual(['s1', 's2']);
    expect(plan.crear).toEqual([]);
  });

  it('mismo NIT con datos fiscales distintos: se reporta y se salta el NIT entero', () => {
    const plan = planificarEmisores(
      [
        { ...base, id: 's1', nit: '900123456' },
        { ...base, id: 's2', nit: '900123456', responsableIva: false },
      ],
      [],
    );
    expect(plan.crear).toEqual([]);
    expect(plan.conflictos).toEqual([
      { nitNorm: '900123456', campos: ['responsableIva'], sedeIds: ['s1', 's2'] },
    ]);
  });

  it('idempotente: las sedes ya enlazadas a un emisor de su NIT no se tocan', () => {
    const emisores = [{ id: 'e1', nitNorm: '900123456', razonSocial: 'Crunchy SAS', nitDv: '7', tipoPersona: 'juridica', responsableIva: true }];
    const plan = planificarEmisores([{ ...base, id: 's1', nit: '900123456', emisorId: 'e1' }], emisores);
    expect(plan.sedesEnlazadas).toBe(1);
    expect(plan.crear).toEqual([]);
    expect(plan.enlazar).toEqual([]);
  });

  it('una sede nueva de un NIT con emisor se enlaza a él si coincide, y si no se reporta', () => {
    const emisores = [{ id: 'e1', nitNorm: '900123456', razonSocial: 'Crunchy SAS', nitDv: '7', tipoPersona: 'juridica', responsableIva: true }];
    const ok = planificarEmisores([{ ...base, id: 's2', nit: '900123456' }], emisores);
    expect(ok.enlazar).toEqual([{ emisorId: 'e1', nitNorm: '900123456', sedeIds: ['s2'] }]);
    const mal = planificarEmisores(
      [{ ...base, id: 's2', nit: '900123456', businessName: 'Otra' }],
      emisores,
    );
    expect(mal.enlazar).toEqual([]);
    expect(mal.conflictos[0]?.campos).toEqual(['razonSocial']);
  });

  it('una sede que apunta a un emisor de otro NIT (cambió el NIT) se reenlaza', () => {
    const emisores = [{ id: 'e1', nitNorm: '111111111', razonSocial: 'Crunchy SAS' }];
    const plan = planificarEmisores([{ ...base, id: 's1', nit: '900123456', emisorId: 'e1' }], emisores);
    expect(plan.crear.map((c) => c.sedeIds)).toEqual([['s1']]);
  });

  it('el NIT sale enmascarado en el log', () => {
    expect(nitEnmascarado('900123456')).toBe('***3456');
    expect(nitEnmascarado('12')).toBe('****');
  });
});
