import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// Los servicios importan esquemas: se neutralizan los decoradores (patrón de
// `orders.service.checkout.spec.ts`).
vi.mock('@nestjs/mongoose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nestjs/mongoose')>();
  return {
    ...actual,
    Prop: () => () => undefined,
    Schema: () => () => undefined,
    SchemaFactory: {
      createForClass: () => ({ index: () => undefined, pre: () => undefined, virtual: () => ({ get: () => undefined }) }),
    },
  };
});

import { DURACION_MAX_FUNCION_MS, DURACION_MAX_HOBBY_SIN_FLUID_MS } from './duracion-funcion';
import {
  BLOQUEO_TRANSMISION_MS,
  MARGEN_BLOQUEO_MS,
  PRESUPUESTO_RED_MAX_MS,
} from '../../modules/einvoicing/application/transmision-dian.service';
import { PRESUPUESTO_POR_DEFECTO_MS } from '../../modules/einvoicing/infrastructure/dian/dian.constants';
import {
  ESPERA_ENTRE_INTENTOS_MS,
  INTENTOS_ANTES_DE_CONTINGENCIA,
} from '../../modules/einvoicing/domain/contingencia';
import { MARGEN_PLAZO_RECONSULTA_MS } from '../../modules/einvoicing/domain/reconsulta';
import { PRESUPUESTO_RECONSULTA_MS } from '../../modules/einvoicing/application/reconsulta-dian.service';
import { PRESUPUESTO_EMISION_MS } from '../../modules/einvoicing/application/nomina-periodo.service';
import { PRESUPUESTO_CORRIDA_MS } from '../../modules/einvoicing/application/habilitacion-nomina.service';
import { PRESUPUESTO_CORRIDA_FACTURA_MS } from '../../modules/einvoicing/application/habilitacion-factura.service';
import { PLAZO_BARRIDOS_MS } from '../../modules/cron/infrastructure/cron.controller';
import { PLAZO_POR_DEFECTO_MS } from '../../modules/sales/application/documento-fiscal-venta.service';

/**
 * Presupuesto de tiempo por llamada frente a la duración máxima de la función
 * (Fase 0 del estudio de factura electrónica). Son cuentas sobre las constantes
 * reales: si una sube y deja de caber, falla aquí y no en producción.
 */

/** Un envío con veredicto: SendBillSync y, si la DIAN dice «ya procesado», GetStatus. */
const ENVIO_Y_CONSULTA_MS = 2 * PRESUPUESTO_RED_MAX_MS;
/**
 * El peor documento: factura o POS en producción sin respuesta de la DIAN
 * (anexo §12.2): tres envíos con 5 s entre ellos y una consulta.
 */
const PEOR_DOCUMENTO_MS =
  INTENTOS_ANTES_DE_CONTINGENCIA * PRESUPUESTO_RED_MAX_MS +
  (INTENTOS_ANTES_DE_CONTINGENCIA - 1) * ESPERA_ENTRE_INTENTOS_MS +
  PRESUPUESTO_RED_MAX_MS;
/** Lo mismo con el timeout real del cliente SOAP (8 s), no con el tope duro (25 s). */
const PEOR_DOCUMENTO_SOAP_MS =
  INTENTOS_ANTES_DE_CONTINGENCIA * PRESUPUESTO_POR_DEFECTO_MS +
  (INTENTOS_ANTES_DE_CONTINGENCIA - 1) * ESPERA_ENTRE_INTENTOS_MS +
  PRESUPUESTO_POR_DEFECTO_MS;

describe('duración máxima de la función en Vercel', () => {
  it('300 s: lo que da Fluid compute en Hobby (por defecto y máximo)', () => {
    expect(DURACION_MAX_FUNCION_MS).toBe(300_000);
  });

  it('vercel.json no declara `functions`: con el preset NestJS no empareja nada y rompe el build', () => {
    const vercel = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')) as Record<string, unknown>;
    expect(vercel.functions).toBeUndefined();
    expect(vercel.builds).toBeUndefined();
    // El cron diario sigue donde estaba.
    expect(vercel.crons).toEqual([{ path: '/cron/diario', schedule: '0 11 * * *' }]);
  });

  it('cliente SOAP: su timeout (8 s) está por debajo del tope duro por llamada (25 s)', () => {
    expect(PRESUPUESTO_POR_DEFECTO_MS).toBeLessThanOrEqual(PRESUPUESTO_RED_MAX_MS);
    expect(PRESUPUESTO_POR_DEFECTO_MS).toBe(8_000);
    expect(PRESUPUESTO_RED_MAX_MS).toBe(25_000);
  });

  it('caja: la espera del cobro (4 s) es menor que una sola llamada a la DIAN; la transmisión va detrás de la respuesta', () => {
    expect(PLAZO_POR_DEFECTO_MS).toBe(4_000);
    expect(PLAZO_POR_DEFECTO_MS).toBeLessThan(PRESUPUESTO_POR_DEFECTO_MS);
    // El `waitUntil` de la transmisión comparte la duración de la función.
    expect(PLAZO_POR_DEFECTO_MS + PEOR_DOCUMENTO_MS).toBeLessThan(DURACION_MAX_FUNCION_MS);
  });

  it('emisión y reintento manual: caben con holgura, incluso el peor caso con los tres envíos', () => {
    expect(ENVIO_Y_CONSULTA_MS).toBe(50_000);
    expect(PEOR_DOCUMENTO_MS).toBe(110_000);
    expect(PEOR_DOCUMENTO_MS).toBeLessThan(DURACION_MAX_FUNCION_MS / 2);
    expect(PEOR_DOCUMENTO_SOAP_MS).toBe(42_000);
  });

  it('bloqueo del documento: dura más que la función y deja margen para guardar el veredicto', () => {
    expect(BLOQUEO_TRANSMISION_MS).toBeGreaterThan(DURACION_MAX_FUNCION_MS);
    expect(PEOR_DOCUMENTO_MS + MARGEN_BLOQUEO_MS).toBeLessThan(BLOQUEO_TRANSMISION_MS);
  });

  it('cron de reconsulta: el último documento que empieza termina antes de que muera la función', () => {
    expect(PRESUPUESTO_RECONSULTA_MS).toBe(PLAZO_BARRIDOS_MS);
    expect(PLAZO_BARRIDOS_MS).toBeLessThan(DURACION_MAX_FUNCION_MS);
    // No se empieza un documento con menos de MARGEN antes del plazo.
    const ultimoInicio = PLAZO_BARRIDOS_MS - MARGEN_PLAZO_RECONSULTA_MS;
    expect(ultimoInicio + PEOR_DOCUMENTO_MS).toBeLessThanOrEqual(DURACION_MAX_FUNCION_MS);
    // Un reenvío normal (nota, nómina) cabe en el margen y deja el resto para responder.
    expect(ENVIO_Y_CONSULTA_MS).toBeLessThan(MARGEN_PLAZO_RECONSULTA_MS);
  });

  it('nómina del periodo y sets de habilitación: cada llamada se corta sola mucho antes', () => {
    for (const ms of [PRESUPUESTO_EMISION_MS, PRESUPUESTO_CORRIDA_MS, PRESUPUESTO_CORRIDA_FACTURA_MS]) {
      expect(ms + ENVIO_Y_CONSULTA_MS).toBeLessThan(DURACION_MAX_FUNCION_MS);
    }
  });

  it('sin Fluid (Hobby, 60 s) seguirían cabiendo los caminos de usuario, no los barridos', () => {
    // Cobro + los tres envíos con el timeout real del SOAP.
    expect(PLAZO_POR_DEFECTO_MS + PEOR_DOCUMENTO_SOAP_MS).toBeLessThan(DURACION_MAX_HOBBY_SIN_FLUID_MS);
    expect(PRESUPUESTO_EMISION_MS + PRESUPUESTO_POR_DEFECTO_MS).toBeLessThan(DURACION_MAX_HOBBY_SIN_FLUID_MS);
    // Los barridos están hechos para 300 s: sin Fluid habría que rehacerlos.
    expect(PLAZO_BARRIDOS_MS).toBeGreaterThan(DURACION_MAX_HOBBY_SIN_FLUID_MS);
  });
});
