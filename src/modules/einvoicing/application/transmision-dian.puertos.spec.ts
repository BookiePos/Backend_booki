import { inspect } from 'util';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// El proveedor importa el servicio de emisores, que importa esquemas: se
// neutralizan los decoradores (patrón de `orders.service.checkout.spec.ts`).
vi.mock('@nestjs/mongoose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nestjs/mongoose')>();
  return {
    ...actual,
    Prop: () => () => undefined,
    Schema: () => () => undefined,
    SchemaFactory: {
      createForClass: () => ({ index: () => undefined, pre: () => undefined }),
    },
  };
});

import {
  AmbienteNoCoincideError,
  MOTIVO_CERTIFICADO_TRANSMISION,
  ProveedorTransmisorPorEmisor,
} from './transmision-dian.puertos';
import { CertificadoCargado } from './fiscal-emitters.service';
import { StubDian } from '../domain/stub-dian';
import { p12DePrueba } from '../domain/p12-de-prueba.test';
import { DirectoDian, type PeticionHttp, type TransporteHttp } from '../infrastructure/dian/directo-dian';
import { URL_DIAN_POR_AMBIENTE } from '../infrastructure/dian/dian.constants';
import { respuestaDocumento } from '../infrastructure/dian/respuestas-dian.test';

/**
 * Conexión de `DirectoDian` en el proveedor de transmisores (PR de
 * integración de la Fase 4). Nada sale a la DIAN real: el transporte se inyecta.
 */

const PASSWORD = 'clave-p12-de-prueba';
let p12: Buffer;

beforeAll(() => {
  p12 = p12DePrueba({ password: PASSWORD });
});

const COMPLETO = {
  certificadoVigente: true,
  softwareId: 'soft-123',
  tienePin: true,
  tipoAmbiente: '2',
  habilitado: false,
  faltaParaTransmitir: [] as string[],
  datosFiscalesFaltantes: [] as string[],
  tieneTestSetId: true,
};

describe('ProveedorTransmisorPorEmisor', () => {
  let emisor: Record<string, unknown>;
  let estado: typeof COMPLETO;
  let emisores: {
    obtenerPorSede: ReturnType<typeof vi.fn>;
    estadoConfiguracion: ReturnType<typeof vi.fn>;
    cargarCertificado: ReturnType<typeof vi.fn>;
    transmisorParaSede: ReturnType<typeof vi.fn>;
  };
  let llamadas: { url: string; init: PeticionHttp }[];
  let transporte: TransporteHttp;

  const proveedor = (t: TransporteHttp | undefined = transporte) =>
    new ProveedorTransmisorPorEmisor(emisores as never, t);

  beforeEach(() => {
    emisor = { id: 'e1', tipoAmbiente: '2', habilitado: false, nitNorm: '900123456' };
    estado = { ...COMPLETO };
    emisores = {
      obtenerPorSede: vi.fn(async () => emisor),
      estadoConfiguracion: vi.fn(async () => estado),
      cargarCertificado: vi.fn(async () => new CertificadoCargado(p12, PASSWORD)),
      transmisorParaSede: vi.fn(),
    };
    llamadas = [];
    transporte = async (url, init) => {
      llamadas.push({ url, init });
      return new Response(respuestaDocumento('SendBillSync', { isValid: 'true', cufe: 'cufe-1' }), { status: 200 });
    };
  });

  it('emisor completo con .p12 vigente: DirectoDian del ambiente del gate, por el transporte inyectado', async () => {
    const t = await proveedor().para('s1', '2');
    expect(t).toBeInstanceOf(DirectoDian);
    expect((t as DirectoDian).urlServicio).toBe(URL_DIAN_POR_AMBIENTE['2']);
    // El certificado se lee por el camino auditado, con su motivo.
    expect(emisores.cargarCertificado).toHaveBeenCalledWith('e1', MOTIVO_CERTIFICADO_TRANSMISION);
    // Nunca por el atajo sin gate.
    expect(emisores.transmisorParaSede).not.toHaveBeenCalled();

    const r = await t.enviar({ tipo: 'invoice', fullNumber: 'SETP990000001', cufe: 'cufe-1', xmlFirmado: '<Invoice/>' });
    expect(r).toMatchObject({ ok: true, isValid: true });
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]!.url).toBe(URL_DIAN_POR_AMBIENTE['2']);
  });

  it('el ambiente sale del gate: producción solo si el gate y el emisor dicen 1', async () => {
    emisor = { ...emisor, tipoAmbiente: '1', habilitado: true };
    const t = await proveedor().para('s1', '1');
    expect((t as DirectoDian).urlServicio).toBe(URL_DIAN_POR_AMBIENTE['1']);
    await expect(proveedor().para('s1', '2')).rejects.toBeInstanceOf(AmbienteNoCoincideError);
  });

  it('sin emisor o con otro ambiente: falla sin leer el certificado', async () => {
    await expect(proveedor().para('s1', '1')).rejects.toBeInstanceOf(AmbienteNoCoincideError);
    emisores.obtenerPorSede.mockResolvedValue(null);
    await expect(proveedor().para('s1', '2')).rejects.toBeInstanceOf(AmbienteNoCoincideError);
    expect(emisores.cargarCertificado).not.toHaveBeenCalled();
  });

  it.each([
    ['sin .p12 vigente', { certificadoVigente: false, faltaParaTransmitir: ['certificado .p12 vigente'] }, 'certificado'],
    ['sin SoftwareID', { softwareId: undefined, faltaParaTransmitir: ['SoftwareID'] }, 'SoftwareID'],
    ['sin PIN', { tienePin: false, faltaParaTransmitir: ['PIN del software'] }, 'PIN'],
  ])('%s: stub con CONFIG_FALTANTE, sin leer el certificado ni salir a la red', async (_n, cambio, texto) => {
    estado = { ...COMPLETO, ...cambio } as typeof COMPLETO;
    const t = await proveedor().para('s1', '2');
    expect(t).toBeInstanceOf(StubDian);
    const r = await t.enviar({ tipo: 'invoice', fullNumber: 'SETP1' });
    expect(r).toMatchObject({ ok: false, codigo: 'CONFIG_FALTANTE', origen: 'adapter' });
    expect(r.mensajes.join(' ')).toContain(texto);
    expect(emisores.cargarCertificado).not.toHaveBeenCalled();
    expect(llamadas).toHaveLength(0);
  });

  it('certificado no disponible (sin archivo o sin llave de cifrado): stub', async () => {
    emisores.cargarCertificado.mockResolvedValue(null);
    const t = await proveedor().para('s1', '2');
    expect(t).toBeInstanceOf(StubDian);
    expect((await t.enviar({ tipo: 'invoice', fullNumber: 'SETP1' })).codigo).toBe('CONFIG_FALTANTE');
  });

  it('.p12 que no abre (contraseña errada): stub con mensaje fijo, sin la contraseña', async () => {
    emisores.cargarCertificado.mockResolvedValue(new CertificadoCargado(p12, 'otra-clave-secreta'));
    const t = await proveedor().para('s1', '2');
    expect(t).toBeInstanceOf(StubDian);
    const r = await t.enviar({ tipo: 'invoice', fullNumber: 'SETP1' });
    expect(r.codigo).toBe('CONFIG_FALTANTE');
    expect(JSON.stringify(r)).not.toContain('otra-clave-secreta');
    expect(llamadas).toHaveLength(0);
  });

  it('NIT del emisor que no sirve para la DIAN: stub, no lanza', async () => {
    emisor = { ...emisor, nitNorm: '' };
    const t = await proveedor().para('s1', '2');
    expect(t).toBeInstanceOf(StubDian);
    expect((await t.enviar({ tipo: 'invoice', fullNumber: 'SETP1' })).codigo).toBe('CONFIG_FALTANTE');
  });

  it('nunca hay credencial global: con variables de entorno de certificado sigue mandando el emisor', async () => {
    const antes = { ...process.env };
    process.env.DIAN_CERT_P12 = 'global';
    process.env.DIAN_SOFTWARE_ID = 'global';
    try {
      estado = { ...COMPLETO, softwareId: undefined, faltaParaTransmitir: ['SoftwareID'] } as never;
      expect(await proveedor().para('s1', '2')).toBeInstanceOf(StubDian);
    } finally {
      process.env = antes;
    }
  });

  it('la llave y la contraseña no salen al serializar ni al inspeccionar el transmisor', async () => {
    const t = await proveedor().para('s1', '2');
    for (const vista of [JSON.stringify(t), inspect(t, { showHidden: true, depth: 10, getters: true }), String(t)]) {
      expect(vista).not.toContain('PRIVATE KEY');
      expect(vista).not.toContain(PASSWORD);
      expect(vista).not.toContain('soft-123');
    }
  });
});
