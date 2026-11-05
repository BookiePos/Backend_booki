import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@nestjs/mongoose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nestjs/mongoose')>();
  return {
    ...actual,
    Prop: () => () => undefined,
    Schema: () => () => undefined,
    SchemaFactory: { createForClass: () => ({ index: () => undefined, pre: () => undefined }) },
  };
});

import { ProveedorTransmisorNomina } from './transmision-dian.puertos';
import { CertificadoCargado } from './fiscal-emitters.service';
import { StubDian } from '../domain/stub-dian';
import { p12DePrueba } from '../domain/p12-de-prueba.test';
import { DirectoDian, type TransporteHttp } from '../infrastructure/dian/directo-dian';

const PASSWORD = 'clave-p12-de-prueba';
let p12: Buffer;
beforeAll(() => {
  p12 = p12DePrueba({ password: PASSWORD });
});

function proveedor(nomina: Record<string, unknown>) {
  const emisores = {
    obtenerPorSede: vi.fn(async () => ({ id: 'e1', tipoAmbiente: '2', nitNorm: '900123456' })),
    // La factura tiene todo; si el proveedor la mirara, armaría el transmisor directo.
    estadoConfiguracion: vi.fn(async () => ({ certificadoVigente: true, softwareId: 'soft-factura', tienePin: true })),
    estadoNomina: vi.fn(async () => nomina),
    cargarCertificado: vi.fn(async () => new CertificadoCargado(p12, PASSWORD)),
  };
  const transporte: TransporteHttp = vi.fn();
  return { emisores, p: new ProveedorTransmisorNomina(emisores as never, transporte) };
}

describe('ProveedorTransmisorNomina', () => {
  it('con credenciales de nómina arma DirectoDian y nunca consulta las de la factura', async () => {
    const { emisores, p } = proveedor({ certificadoVigente: true, softwareId: 'sw-nomina', tienePin: true });
    expect(await p.para('s1', '2')).toBeInstanceOf(DirectoDian);
    expect(emisores.estadoNomina).toHaveBeenCalledWith('e1');
    expect(emisores.estadoConfiguracion).not.toHaveBeenCalled();
  });

  it.each([
    ['sin SoftwareID de nómina', { certificadoVigente: true, softwareId: undefined, tienePin: true }, 'SoftwareID'],
    ['sin PIN de nómina', { certificadoVigente: true, softwareId: 'sw', tienePin: false }, 'PIN'],
  ])('%s: stub CONFIG_FALTANTE aunque la factura esté completa, y no toca el certificado', async (_n, estado, texto) => {
    const { emisores, p } = proveedor(estado);
    const t = await p.para('s1', '2');
    expect(t).toBeInstanceOf(StubDian);
    expect((await t.enviar({ tipo: 'payroll', fullNumber: 'NE1' })).codigo).toBe('CONFIG_FALTANTE');
    expect((await t.enviar({ tipo: 'payroll', fullNumber: 'NE1' })).mensajes.join(' ')).toContain(texto);
    expect(emisores.cargarCertificado).not.toHaveBeenCalled();
  });
});
