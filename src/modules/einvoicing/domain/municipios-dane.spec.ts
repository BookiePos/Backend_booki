import { describe, expect, it } from 'vitest';
import { listarMunicipiosDane, municipioDesdeTexto, municipioPorCodigo } from './municipios-dane';

describe('municipios DANE', () => {
  it('trae el catálogo completo, con códigos de 5 dígitos y sin repetidos', () => {
    const todos = listarMunicipiosDane();
    expect(todos.length).toBe(1122);
    expect(todos.every((m) => /^\d{5}$/.test(m.codigo))).toBe(true);
    expect(new Set(todos.map((m) => m.codigo)).size).toBe(todos.length);
  });

  it('busca por código', () => {
    expect(municipioPorCodigo('05615')).toMatchObject({ municipio: 'RIONEGRO', departamento: 'ANTIOQUIA' });
    expect(municipioPorCodigo('99999')).toBeUndefined();
  });

  it('deduce el código del texto de la sede, sin tildes ni mayúsculas', () => {
    expect(municipioDesdeTexto('Antioquia', 'Rionegro')?.codigo).toBe('05615');
    expect(municipioDesdeTexto('antioquia', 'marinilla')?.codigo).toBe('05440');
    expect(municipioDesdeTexto('Antioquia', 'Medellin')?.codigo).toBe('05001');
    expect(municipioDesdeTexto('Cundinamarca', 'Bogotá')?.codigo).toBe('11001');
    expect(municipioDesdeTexto('', 'Bogotá D.C.')?.codigo).toBe('11001');
    expect(municipioDesdeTexto('Valle del Cauca', 'Cali')?.codigo).toBe('76001');
  });

  it('no adivina: nombre repetido entre departamentos sin departamento, o ciudad desconocida', () => {
    // Rionegro existe en Antioquia y en Santander.
    expect(municipioDesdeTexto('', 'Rionegro')).toBeUndefined();
    expect(municipioDesdeTexto('Santander', 'Rionegro')?.codigo).toMatch(/^68/);
    expect(municipioDesdeTexto('Antioquia', 'Ciudad que no existe')).toBeUndefined();
    expect(municipioDesdeTexto('Antioquia', '')).toBeUndefined();
  });
});
