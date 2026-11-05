import { describe, expect, it } from 'vitest';
import { empleadorDeEmisor, relojColombia } from './empleador';

const base = { razonSocial: 'X SAS', nit: '900.123.456-7', nitNorm: '900123456', nitDv: '7', direccion: 'Cl 1', municipioDane: '05001' };

describe('empleadorDeEmisor', () => {
  it('arma el empleador con el departamento del DANE', () => {
    expect(empleadorDeEmisor(base)).toMatchObject({
      ok: true,
      empleador: { nit: '900123456', dv: '7', departamento: '05', municipio: '05001' },
    });
  });

  it('falla cerrado con todos los motivos', () => {
    const r = empleadorDeEmisor({ ...base, razonSocial: '', nitDv: undefined, direccion: undefined, municipioDane: '5' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivos).toHaveLength(4);
  });

  it('reloj de Colombia (UTC-5)', () => {
    expect(relojColombia(new Date('2026-11-06T02:30:00Z'))).toEqual({ fecha: '2026-11-05', hora: '21:30:00-05:00' });
  });
});
