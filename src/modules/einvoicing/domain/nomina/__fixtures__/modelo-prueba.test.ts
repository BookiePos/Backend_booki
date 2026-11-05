import type { ModeloNominaAjuste, ModeloNominaIndividual } from '../modelo';
import { TipoNota } from '../modelo';

/**
 * Modelos de nómina de prueba para los specs de firma y transmisión (no es un
 * spec). Sueldo $1.500.000, salud y pensión al 4 %.
 */
export const NIT_EMPLEADOR = '900123456';

export function modeloIndividual(cambios: { documento?: string; fin?: string } = {}): ModeloNominaIndividual {
  return {
    emision: {
      fecha: '2026-10-31',
      hora: '10:30:00-05:00',
      prefijo: 'NE',
      consecutivo: 1,
      empleador: {
        nit: NIT_EMPLEADOR,
        dv: '7',
        razonSocial: 'Panadería El Trigo S.A.S.',
        departamento: '05',
        municipio: '05001',
        direccion: 'Calle 10 # 20-30',
      },
    },
    documento: {
      periodo: {
        fechaIngreso: '2024-02-01',
        fechaLiquidacionInicio: '2026-10-01',
        fechaLiquidacionFin: cambios.fin ?? '2026-10-31',
        tiempoLaborado: 987,
      },
      periodoNomina: '5',
      trabajador: {
        tipoTrabajador: '01',
        subTipoTrabajador: '00',
        altoRiesgoPension: false,
        tipoDocumento: '13',
        numeroDocumento: cambios.documento ?? '1017123456',
        primerApellido: 'Pérez',
        segundoApellido: 'Gómez',
        primerNombre: 'Ana',
        lugarTrabajo: { departamento: '05', municipio: '05001', direccion: 'Calle 10 # 20-30' },
        salarioIntegral: false,
        tipoContrato: '1',
        sueldo: 150_000_000,
      },
      pago: { forma: '1', metodo: '10' },
      fechasPagos: ['2026-10-31'],
      devengados: {
        basico: { dias: 30, sueldo: 150_000_000 },
        horas: [],
        vacacionesComunes: [],
        vacacionesCompensadas: [],
        incapacidades: [],
        licenciasMP: [],
        bonificaciones: [],
        auxilios: [],
        otrosConceptos: [],
        comisiones: [],
        pagosTerceros: [],
      },
      deducciones: {
        salud: { porcentaje: 4, valor: 6_000_000 },
        fondoPension: { porcentaje: 4, valor: 6_000_000 },
        sindicatos: [],
        sanciones: [],
        libranzas: [],
        pagosTerceros: [],
        anticipos: [],
        otras: [],
      },
    },
  };
}

export function modeloAjuste(
  tipoNota: 1 | 2,
  cunePredecesor: string,
  numeroPredecesor = 'NE1',
): ModeloNominaAjuste {
  const base = modeloIndividual();
  const predecesor = { numero: numeroPredecesor, cune: cunePredecesor, fecha: '2026-10-31' };
  if (tipoNota === TipoNota.Eliminar) {
    return { tipoNota: TipoNota.Eliminar, emision: { ...base.emision, fecha: '2026-11-05' }, predecesor };
  }
  return {
    tipoNota: TipoNota.Reemplazar,
    emision: { ...base.emision, fecha: '2026-11-05' },
    predecesor,
    documento: base.documento,
  };
}
