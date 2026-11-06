import { describe, expect, it } from 'vitest';
import type { PayrollBreakdown } from '../../../payroll/domain/payroll-calc';
import {
  consolidarNominaMes,
  tiempoLaborado360,
  totalesDeModelo,
  type CorridaColilla,
  type DeduccionConsolidar,
  type EntradaConsolidar,
  type EmpleadoConsolidar,
  type LiquidacionConsolidar,
  type ResultadoConsolidar,
} from './consolidar';
import type { ContextoNomina, DocumentoNe, EmisionNe } from './modelo';
import { armarNominaIndividual } from './xml-nomina';
import { validarXsdNomina } from './__fixtures__/validar-xsd-nomina.test';

const ctx: ContextoNomina = { tipoAmbiente: '2', softwareId: 'sw-nomina-1', softwarePin: '12345' };
const emision: EmisionNe = {
  fecha: '2026-11-03',
  hora: '10:30:00-05:00',
  prefijo: 'NE',
  consecutivo: 1,
  empleador: {
    nit: '900123456',
    dv: '7',
    razonSocial: 'Panadería El Trigo S.A.S.',
    departamento: '05',
    municipio: '05001',
    direccion: 'Calle 10 # 20-30',
  },
};

const empleado = (o: Partial<EmpleadoConsolidar> = {}): EmpleadoConsolidar => ({
  id: 'emp1',
  docType: 'CC',
  docNumber: '1017123456',
  firstName: 'Ana',
  lastName: 'Pérez',
  secondLastName: 'Gómez',
  docTypeDian: '13',
  tipoTrabajador: '01',
  subTipoTrabajador: '00',
  contractType: 'indefinido',
  tipoContratoDian: '2',
  hireDate: '2024-02-01',
  salary: 1_500_000,
  municipioDaneTrabajo: '05001',
  direccionTrabajo: 'Calle 1 # 2-3',
  medioPago: '10',
  ...o,
});

interface OpcionesBd {
  salario?: number;
  aux?: number;
  detalle?: { key: string; horas: number; factor: number; valor: number }[];
  bonS?: number;
  bonNS?: number;
  com?: number;
  salud?: number;
  pension?: number;
  fsp?: number;
  rete?: number;
  otras?: number;
  ibc?: number;
  extra?: Record<string, number>;
}

function breakdown(o: OpcionesBd): PayrollBreakdown {
  const detalle = o.detalle ?? [];
  const extras = detalle.filter((l) => l.key.startsWith('extra')).reduce((s, l) => s + l.valor, 0);
  const recargos = detalle.reduce((s, l) => s + l.valor, 0) - extras;
  const salario = o.salario ?? 1_500_000;
  const aux = o.aux ?? 0;
  const totalDev = salario + aux + recargos + extras + (o.bonS ?? 0) + (o.bonNS ?? 0) + (o.com ?? 0);
  const ibc = o.ibc ?? salario + recargos + extras + (o.bonS ?? 0) + (o.com ?? 0);
  const salud = o.salud ?? Math.round(ibc * 0.04);
  const pension = o.pension ?? Math.round(ibc * 0.04);
  const totalDed = salud + pension + (o.fsp ?? 0) + (o.rete ?? 0) + (o.otras ?? 0);
  return {
    diasTrabajados: 30,
    divisorHoras: 210,
    horaOrdinaria: 7000,
    devengados: {
      salario,
      auxilioTransporte: aux,
      recargos,
      horasExtra: extras,
      recargoDetalle: detalle.map((l) => ({ ...l, label: l.key })),
      bonificacionSalarial: o.bonS ?? 0,
      bonificacionNoSalarial: o.bonNS ?? 0,
      comisiones: o.com ?? 0,
      total: totalDev,
      ...o.extra,
    },
    ibc,
    deducciones: { salud, pension, fsp: o.fsp ?? 0, retencionFuente: o.rete ?? 0, otras: o.otras ?? 0, total: totalDed },
    aportesEmpleador: { salud: 1, pension: 1, arl: 1, ccf: 1, sena: 1, icbf: 1, total: 6 },
    provisiones: { cesantias: 1, interesesCesantias: 1, prima: 1, vacaciones: 1, total: 4 },
    netoPagar: totalDev - totalDed,
    costoEmpleador: 0,
    baseRetencionUvt: 0,
  } as unknown as PayrollBreakdown;
}

interface OpcionesCorrida extends Partial<Omit<CorridaColilla, 'colilla'>> {
  bd?: PayrollBreakdown;
  dias?: number;
  detalleOtras?: { concept: string; amount: number; source?: string }[];
}

const corrida = (o: OpcionesCorrida = {}): CorridaColilla => ({
  corridaId: o.corridaId ?? 'run1',
  periodo: o.periodo ?? '2026-10',
  cobertura: o.cobertura ?? 'all',
  sedeId: o.sedeId,
  estado: o.estado ?? 'cerrada',
  rango: o.rango,
  pago: 'pago' in o ? o.pago : { medio: '10', fecha: '2026-10-31' },
  colilla: {
    employeeId: 'emp1',
    diasTrabajados: o.dias ?? 30,
    breakdown: o.bd ?? breakdown({}),
    otrasDeduccionesDetalle: o.detalleOtras ?? [],
  },
});

const entrada = (o: Partial<EntradaConsolidar> = {}): EntradaConsolidar => ({
  periodo: '2026-10',
  empleado: empleado(),
  empleador: { municipioDane: '05001', direccion: 'Calle 10 # 20-30' },
  slips: [corrida()],
  deducciones: [],
  ...o,
});

function ok(e: EntradaConsolidar): Extract<ResultadoConsolidar, { ok: true }> {
  const r = consolidarNominaMes(e);
  if (!r.ok) throw new Error(`bloqueado: ${r.bloqueos.join(' | ')}`);
  return r;
}
const bloqueos = (e: EntradaConsolidar): string[] => {
  const r = consolidarNominaMes(e);
  if (r.ok) throw new Error('se esperaba bloqueo');
  return r.bloqueos;
};

/** El modelo arma, valida contra el XSD y los totales cuadran con las colillas. */
async function verificar(modelo: DocumentoNe, devPesos: number, dedPesos: number) {
  const t = totalesDeModelo(modelo);
  expect(t.devengados).toBe(devPesos * 100);
  expect(t.deducciones).toBe(dedPesos * 100);
  const r = armarNominaIndividual({ emision, documento: modelo }, ctx);
  expect(r.totales.devengados).toBe(devPesos * 100);
  expect(r.totales.deducciones).toBe(dedPesos * 100);
  const xsd = await validarXsdNomina(r.xml, 'consolidado.xml');
  expect(xsd.errores).toEqual([]);
  return r;
}

describe('consolidarNominaMes: casos que pasan', () => {
  it('corrida mensual simple: básico, salud y pensión, y pasa el XSD', async () => {
    const { modelo, advertencias } = ok(entrada());
    expect(modelo.periodoNomina).toBe('5');
    expect(modelo.devengados.basico).toEqual({ dias: 30, sueldo: 150_000_000 });
    expect(modelo.deducciones.salud).toEqual({ porcentaje: 4, valor: 6_000_000 });
    expect(modelo.deducciones.fondoPension).toEqual({ porcentaje: 4, valor: 6_000_000 });
    expect(modelo.trabajador.lugarTrabajo).toEqual({ departamento: '05', municipio: '05001', direccion: 'Calle 1 # 2-3' });
    expect(modelo.periodo).toMatchObject({ fechaLiquidacionInicio: '2026-10-01', fechaLiquidacionFin: '2026-10-31' });
    expect(advertencias).toEqual([]);
    await verificar(modelo, 1_500_000, 120_000);
  }, 60_000);

  it('auxilio de transporte, bonificaciones y comisiones', async () => {
    const bd = breakdown({ salario: 1_400_000, aux: 200_000, bonS: 100_000, bonNS: 50_000, com: 80_000 });
    const { modelo } = ok(entrada({ slips: [corrida({ bd })] }));
    expect(modelo.devengados.transporte).toEqual({ auxilio: 20_000_000 });
    expect(modelo.devengados.bonificaciones).toEqual([{ s: 10_000_000, ns: 5_000_000 }]);
    expect(modelo.devengados.comisiones).toEqual([8_000_000]);
    await verificar(modelo, bd.devengados.total, bd.deducciones.total);
  }, 60_000);

  it('horas extra y recargos varios con su % de recargo', async () => {
    const detalle = [
      { key: 'recargoNocturno', horas: 10, factor: 0.35, valor: 24_500 },
      { key: 'dominical', horas: 8, factor: 0.9, valor: 50_400 },
      { key: 'nocturnoDominical', horas: 2, factor: 1.25, valor: 17_500 },
      { key: 'extraDiurna', horas: 5.5, factor: 0.25, valor: 48_125 },
      { key: 'extraNocturna', horas: 3, factor: 0.75, valor: 36_750 },
      { key: 'extraDiurnaDominical', horas: 1, factor: 1.15, valor: 15_050 },
      { key: 'extraNocturnaDominical', horas: 1, factor: 1.65, valor: 18_550 },
    ];
    const bd = breakdown({ detalle });
    const { modelo } = ok(entrada({ slips: [corrida({ bd })] }));
    const por = Object.fromEntries(modelo.devengados.horas.map((h) => [h.tipo, h]));
    expect(por.HED).toMatchObject({ cantidad: 5.5, porcentaje: 25, pago: 4_812_500 });
    expect(por.HEN).toMatchObject({ porcentaje: 75 });
    expect(por.HRN).toMatchObject({ porcentaje: 35 });
    expect(por.HRDDF).toMatchObject({ porcentaje: 90 });
    expect(por.HRNDF).toMatchObject({ porcentaje: 125 });
    expect(por.HEDDF).toMatchObject({ porcentaje: 115 });
    expect(por.HENDF).toMatchObject({ porcentaje: 165 });
    expect(modelo.devengados.horas.map((h) => h.tipo)).toEqual(['HED', 'HEN', 'HRN', 'HEDDF', 'HRDDF', 'HENDF', 'HRNDF']);
    await verificar(modelo, bd.devengados.total, bd.deducciones.total);
  }, 60_000);

  it('FSP se parte en solidaridad 0,5 % y subsistencia', async () => {
    const bd = breakdown({ salario: 6_000_000, fsp: 60_000 });
    const { modelo } = ok(entrada({ slips: [corrida({ bd })], empleado: empleado({ salary: 6_000_000 }) }));
    expect(modelo.deducciones.fondoSP).toEqual({ porcentaje: 0.5, valor: 3_000_000, porcentajeSub: 0.5, valorSub: 3_000_000 });
    await verificar(modelo, 6_000_000, bd.deducciones.total);
  }, 60_000);

  it('consumos y fiado van a Deuda, el arrastre a Deuda y lo manual a OtraDeduccion', async () => {
    const dets = [
      { concept: 'Consumo', amount: 30_000 },
      { concept: 'Saldo anterior', amount: 10_000, source: 'arrastre' },
      { concept: 'Préstamo', amount: 50_000 },
    ];
    const bd = breakdown({ otras: 90_000 });
    const deducciones: DeduccionConsolidar[] = [
      { employeeId: 'emp1', concept: 'Consumo', amount: 30_000, source: 'sale', appliedRunId: 'run1' },
      { employeeId: 'emp1', concept: 'Préstamo', amount: 50_000, source: 'manual', appliedRunId: 'run1' },
    ];
    const { modelo } = ok(entrada({ slips: [corrida({ bd, detalleOtras: dets })], deducciones }));
    expect(modelo.deducciones.deuda).toBe(4_000_000);
    expect(modelo.deducciones.otras).toEqual([5_000_000]);
    await verificar(modelo, 1_500_000, bd.deducciones.total);
  }, 60_000);

  it('retención en la fuente', async () => {
    const bd = breakdown({ salario: 5_000_000, rete: 100_000 });
    const { modelo } = ok(entrada({ slips: [corrida({ bd })], empleado: empleado({ salary: 5_000_000 }) }));
    expect(modelo.deducciones.retencionFuente).toBe(10_000_000);
    await verificar(modelo, 5_000_000, bd.deducciones.total);
  }, 60_000);

  it('dos quincenas se suman: días, sueldo, horas del mismo tipo y %', async () => {
    const h = (valor: number) => [{ key: 'extraDiurna', horas: 2, factor: 0.25, valor }];
    const a = breakdown({ salario: 750_000, detalle: h(17_500) });
    const b = breakdown({ salario: 750_000, detalle: h(17_500) });
    const { modelo } = ok(
      entrada({
        slips: [
          corrida({ corridaId: 'q1', bd: a, dias: 15, rango: { desde: '2026-10-01', hasta: '2026-10-15' }, pago: { medio: '10', fecha: '2026-10-15' } }),
          corrida({ corridaId: 'q2', bd: b, dias: 15, rango: { desde: '2026-10-16', hasta: '2026-10-31' } }),
        ],
      }),
    );
    expect(modelo.periodoNomina).toBe('4');
    expect(modelo.devengados.basico).toEqual({ dias: 30, sueldo: 150_000_000 });
    expect(modelo.devengados.horas).toEqual([{ tipo: 'HED', cantidad: 4, porcentaje: 25, pago: 3_500_000 }]);
    expect(modelo.fechasPagos).toEqual(['2026-10-15', '2026-10-31']);
    await verificar(modelo, a.devengados.total + b.devengados.total, a.deducciones.total + b.deducciones.total);
  }, 60_000);

  it('el mismo tipo de hora con dos porcentajes queda en dos nodos', () => {
    const a = breakdown({ detalle: [{ key: 'dominical', horas: 4, factor: 0.8, valor: 20_000 }] });
    const b = breakdown({ detalle: [{ key: 'dominical', horas: 4, factor: 0.9, valor: 22_000 }] });
    const { modelo } = ok(
      entrada({
        slips: [
          corrida({ corridaId: 'q1', bd: a, dias: 15, rango: { desde: '2026-10-01', hasta: '2026-10-15' } }),
          corrida({ corridaId: 'q2', bd: b, dias: 15, rango: { desde: '2026-10-16', hasta: '2026-10-31' } }),
        ],
      }),
    );
    expect(modelo.devengados.horas.map((x) => x.porcentaje)).toEqual([80, 90]);
  });

  it('ingreso a mitad de mes; la fecha de pago es la declarada en el cierre', () => {
    const r = ok(entrada({ empleado: empleado({ hireDate: '2026-10-16' }), slips: [corrida({ pago: { medio: '10', fecha: '2026-11-03' } })] }));
    expect(r.modelo.periodo.fechaLiquidacionInicio).toBe('2026-10-16');
    expect(r.modelo.periodo.tiempoLaborado).toBe(15);
    expect(r.modelo.fechasPagos).toEqual(['2026-11-03']);
    expect(r.modelo.pago.metodo).toBe('10');
  });

  it('dos corridas con medios distintos: manda el de mayor valor pagado y avisa', () => {
    const { modelo } = ok(
      entrada({
        slips: [
          corrida({ corridaId: 'q1', dias: 15, bd: breakdown({ salario: 1_000_000 }), rango: { desde: '2026-10-01', hasta: '2026-10-15' }, pago: { medio: '10', fecha: '2026-10-15' } }),
          corrida({ corridaId: 'q2', dias: 15, bd: breakdown({ salario: 500_000 }), rango: { desde: '2026-10-16', hasta: '2026-10-31' }, pago: { medio: '20', fecha: '2026-10-31' } }),
        ],
      }),
    );
    expect(modelo.pago.metodo).toBe('10');
  });

  it('dos corridas de igual valor con medios distintos: desempata el último pago y avisa', () => {
    const { modelo, advertencias } = ok(
      entrada({
        empleado: empleado({ bank: 'Bancolombia', accountType: 'ahorros', accountNumber: '123' }),
        slips: [
          corrida({ corridaId: 'q1', dias: 15, bd: breakdown({ salario: 750_000 }), rango: { desde: '2026-10-01', hasta: '2026-10-15' }, pago: { medio: '10', fecha: '2026-10-15' } }),
          corrida({ corridaId: 'q2', dias: 15, bd: breakdown({ salario: 750_000 }), rango: { desde: '2026-10-16', hasta: '2026-10-31' }, pago: { medio: '47', fecha: '2026-10-31' } }),
        ],
      }),
    );
    expect(modelo.pago.metodo).toBe('47');
    expect(advertencias.join()).toMatch(/medios distintos/);
  });

  it('municipio del emisor como respaldo, con advertencia; segundo apellido partido', () => {
    const r = ok(
      entrada({
        empleado: empleado({ municipioDaneTrabajo: undefined, direccionTrabajo: undefined, secondLastName: undefined, lastName: 'Pérez Gómez' }),
        empleador: { municipioDane: '11001', direccion: 'Carrera 7' },
      }),
    );
    expect(r.modelo.trabajador.lugarTrabajo).toEqual({ departamento: '11', municipio: '11001', direccion: 'Carrera 7' });
    expect(r.modelo.trabajador.primerApellido).toBe('Pérez');
    expect(r.modelo.trabajador.segundoApellido).toBe('Gómez');
    expect(r.advertencias.length).toBeGreaterThanOrEqual(2);
  });

  it('transferencia lleva banco, tipo y número de cuenta', () => {
    const r = ok(
      entrada({
        empleado: empleado({ bank: 'Bancolombia', accountType: 'ahorros', accountNumber: '123456789' }),
        slips: [corrida({ pago: { medio: '47', fecha: '2026-10-31' } })],
      }),
    );
    expect(r.modelo.pago).toEqual({ forma: '1', metodo: '47', banco: 'Bancolombia', tipoCuenta: 'ahorros', numeroCuenta: '123456789' });
  });

  it('pensionado por vejez sin descuento de pensión: FondoPension en 0', async () => {
    const bd = breakdown({ pension: 0 });
    const { modelo } = ok(entrada({ slips: [corrida({ bd })], empleado: empleado({ subTipoTrabajador: '01' }) }));
    expect(modelo.deducciones.fondoPension).toEqual({ porcentaje: 0, valor: 0 });
    await verificar(modelo, 1_500_000, bd.deducciones.total);
  }, 60_000);

  it('neto negativo: recorta las deducciones de nómina y avisa', async () => {
    // Devenga 100.000; salud + pensión 8.000; deducciones de nómina 150.000: se reporta solo lo que alcanza (92.000).
    const bd = breakdown({ salario: 100_000, otras: 150_000, ibc: 100_000, salud: 4_000, pension: 4_000 });
    const { modelo, advertencias } = ok(
      entrada({
        slips: [corrida({ bd, detalleOtras: [{ concept: 'Préstamo', amount: 100_000 }, { concept: 'Consumo', amount: 50_000 }] })],
        deducciones: [{ employeeId: 'emp1', concept: 'Consumo', amount: 50_000, source: 'sale', appliedRunId: 'run1' }],
        empleado: empleado({ salary: 100_000 }),
      }),
    );
    expect(modelo.deducciones.otras).toEqual([4_200_000]);
    expect(modelo.deducciones.deuda).toBe(5_000_000);
    expect(advertencias.join(' ')).toMatch(/negativo/);
    await verificar(modelo, 100_000, 100_000);
  }, 60_000);
});

describe('consolidarNominaMes: retiro en el mes (decisión 4 del dueño)', () => {
  const liq = (o: Partial<LiquidacionConsolidar> = {}): LiquidacionConsolidar => ({
    id: 'liq1',
    fechaRetiro: '2026-10-20',
    diasLiquidados: 980,
    diasPrima: 110,
    cesantias: 4_083_333,
    interesesCesantias: 1_333_889,
    prima: 458_333,
    vacaciones: 2_041_667,
    indemnizacion: 1_000_000,
    salariosPendientes: 0,
    pago: { medio: '10', fecha: '2026-10-25' },
    ...o,
  });
  // Colilla del mes del retiro: 20 días, con salud y pensión (el último sueldo ya no va como «salarios pendientes»).
  const bd20 = () => breakdown({ salario: 1_000_000 });
  const retiro = (l: LiquidacionConsolidar | undefined, e: Partial<EmpleadoConsolidar> = {}) =>
    entrada({
      empleado: empleado({ terminationDate: '2026-10-20', ...e }),
      slips: [corrida({ dias: 20, bd: bd20(), pago: { medio: '10', fecha: '2026-10-20' } })],
      ...(l ? { liquidacion: l } : {}),
    });

  it('lleva cesantías, intereses, prima, vacaciones compensadas e indemnización, y pasa el XSD', async () => {
    const l = liq();
    const { modelo } = ok(retiro(l));
    expect(modelo.periodo).toMatchObject({
      fechaRetiro: '2026-10-20',
      fechaLiquidacionFin: '2026-10-20',
    });
    expect(modelo.devengados.basico.dias).toBe(20);
    expect(modelo.devengados.cesantias).toEqual({ pago: 408_333_300, porcentaje: 12, intereses: 133_388_900 });
    expect(modelo.devengados.primas).toEqual({ dias: 110, pago: 45_833_300 });
    expect(modelo.devengados.vacacionesCompensadas).toEqual([{ dias: 41, pago: 204_166_700 }]);
    expect(modelo.devengados.indemnizacion).toBe(100_000_000);
    expect(modelo.fechasPagos).toEqual(['2026-10-20', '2026-10-25']);
    const dev = bd20().devengados.total + l.cesantias + l.interesesCesantias + l.prima + l.vacaciones + l.indemnizacion;
    await verificar(modelo, dev, bd20().deducciones.total);
  }, 60_000);

  it('la fecha de retiro de la liquidación debe ser la del expediente', () => {
    expect(bloqueos(retiro(liq(), { terminationDate: '2026-10-19' })).join()).toMatch(/liquidación aprobada es de un retiro el 2026-10-20/);
  });

  it('salarios pendientes en la liquidación bloquean (el último sueldo va en la colilla)', () => {
    expect(bloqueos(retiro(liq({ salariosPendientes: 300_000 }))).join()).toMatch(/salarios pendientes/);
  });

  it('liquidación sin pago válido o con importes no enteros bloquea', () => {
    expect(bloqueos(retiro(liq({ pago: undefined }))).join()).toMatch(/medio y una fecha de pago válidos/);
    expect(bloqueos(retiro(liq({ prima: 10.5 }))).join()).toMatch(/pesos enteros/);
    expect(bloqueos(retiro(liq({ diasPrima: undefined }))).join()).toMatch(/días del semestre/);
  });

  it('vacaciones de pocos días reportan al menos 1 día', () => {
    const { modelo } = ok(retiro(liq({ diasLiquidados: 10, vacaciones: 41_667 })));
    expect(modelo.devengados.vacacionesCompensadas).toEqual([{ dias: 1, pago: 4_166_700 }]);
  });
});

describe('consolidarNominaMes: bloqueos por trabajador', () => {
  const caso = (nombre: string, e: Partial<EmpleadoConsolidar>, patron: RegExp) =>
    it(nombre, () => expect(bloqueos(entrada({ empleado: empleado(e) })).join('\n')).toMatch(patron));

  caso('falta el tipo de documento DIAN', { docTypeDian: undefined }, /tipo de documento DIAN/);
  caso('tipo de documento 31 NIT', { docTypeDian: '31' }, /NIT/);
  caso('número de documento no numérico', { docNumber: 'AB123' }, /no es numérico/);
  caso('falta el tipo de trabajador', { tipoTrabajador: undefined }, /tipo de trabajador/);
  caso('falta el subtipo', { subTipoTrabajador: undefined }, /subtipo/);
  caso('falta el tipo de contrato DIAN', { tipoContratoDian: undefined }, /tipo de contrato DIAN/);
  caso('falta la fecha de ingreso', { hireDate: undefined }, /fecha de ingreso/);
  caso('falta el salario', { salary: undefined }, /salario/);
  it('corrida cerrada sin pago declarado: dice qué falta', () => {
    expect(bloqueos(entrada({ slips: [corrida({ pago: undefined })] })).join()).toMatch(/el medio de pago ni la fecha real de pago/);
    expect(bloqueos(entrada({ slips: [corrida({ pago: { medio: '10', fecha: '' } })] })).join()).toMatch(/no tiene declarado la fecha real de pago/);
  });
  it('medio de pago no admitido para nómina', () => {
    expect(bloqueos(entrada({ slips: [corrida({ pago: { medio: '48', fecha: '2026-10-31' } })] })).join()).toMatch(/no es válido para nómina/);
  });
  it('transferencia sin datos de cuenta', () => {
    const b = bloqueos(entrada({ slips: [corrida({ pago: { medio: '47', fecha: '2026-10-31' } })] }));
    expect(b.join()).toMatch(/banco, tipo de cuenta, número de cuenta/);
  });
  it('salario integral por debajo de 13 SMMLV bloquea (art. 132 CST)', () => {
    const e = empleado({ salaryType: 'integral', salary: 20_000_000 });
    expect(bloqueos(entrada({ empleado: e, smmlv: 1_750_905 })).join()).toMatch(/13 SMMLV/);
  });
  caso('docTypeDian no coincide con docType', { docType: 'CE', docTypeDian: '13' }, /no coincide con el código DIAN 13/);
  caso('tipoContratoDian no coincide con contractType', { contractType: 'fijo', tipoContratoDian: '2' }, /no coincide con el código DIAN 2/);
  caso('prestación de servicios no va en nómina electrónica', { contractType: 'prestacion_servicios' }, /prestación de servicios/);
  caso('retiro en el mes sin liquidación aprobada', { terminationDate: '2026-10-20' }, /no tiene liquidación de retiro aprobada/);

  it('sin municipio propio ni del emisor', () => {
    const b = bloqueos(entrada({ empleado: empleado({ municipioDaneTrabajo: undefined }), empleador: {} }));
    expect(b.join()).toMatch(/municipio DANE/);
  });

  it('junta varios bloqueos del mismo trabajador', () => {
    const b = bloqueos(entrada({ empleado: empleado({ docTypeDian: undefined, salary: undefined, hireDate: undefined }) }));
    expect(b.length).toBeGreaterThanOrEqual(3);
  });

  it('corrida en borrador', () => {
    expect(bloqueos(entrada({ slips: [corrida({ estado: 'borrador' })] })).join()).toMatch(/borrador/);
  });

  it('sin corridas del mes', () => {
    expect(bloqueos(entrada({ slips: [] })).join()).toMatch(/ninguna corrida cerrada/);
  });

  it('dos corridas cerradas del mismo mes, all y sede', () => {
    const b = bloqueos(
      entrada({ slips: [corrida({ corridaId: 'a', cobertura: 'all' }), corrida({ corridaId: 'b', cobertura: 'sede', sedeId: 's1' })] }),
    );
    expect(b.join()).toMatch(/se solapan/);
  });

  it('dos corridas de la misma sede sin rango se solapan; con rangos distintos no', () => {
    const dos = (r1?: { desde: string; hasta: string }, r2?: { desde: string; hasta: string }) =>
      entrada({
        slips: [
          corrida({ corridaId: 'a', cobertura: 'sede', sedeId: 's1', rango: r1, dias: 15 }),
          corrida({ corridaId: 'b', cobertura: 'sede', sedeId: 's1', rango: r2, dias: 15 }),
        ],
      });
    expect(bloqueos(dos())[0]).toMatch(/solapan/);
    expect(
      consolidarNominaMes(dos({ desde: '2026-10-01', hasta: '2026-10-15' }, { desde: '2026-10-16', hasta: '2026-10-31' })).ok,
    ).toBe(true);
  });

  it('pensionado por vejez con descuento de pensión', () => {
    expect(bloqueos(entrada({ empleado: empleado({ subTipoTrabajador: '01' }) })).join()).toMatch(/pensionado por vejez/);
  });

  it('neto negativo sin deducciones que recortar', () => {
    const bd = breakdown({ salario: 100_000, ibc: 100_000, salud: 60_000, pension: 60_000 });
    expect(bloqueos(entrada({ slips: [corrida({ bd })], empleado: empleado({ salary: 100_000 }) })).join()).toMatch(
      /no puede ser negativo/,
    );
  });

  it('concepto de la colilla que BookiPos no sabe reportar (prima, cesantías…)', () => {
    const bd = breakdown({ extra: { prima: 500_000 } });
    expect(bloqueos(entrada({ slips: [corrida({ bd })] })).join()).toMatch(/«prima».*tarea 11/);
  });

  it('colilla que no cuadra consigo misma', () => {
    const bd = breakdown({});
    bd.devengados.total += 1;
    expect(bloqueos(entrada({ slips: [corrida({ bd })] })).join()).toMatch(/no cuadran entre sí/);
  });

  it('detalle de otras deducciones que no suma', () => {
    const bd = breakdown({ otras: 10_000 });
    expect(bloqueos(entrada({ slips: [corrida({ bd, detalleOtras: [] })] })).join()).toMatch(/detalle de otras deducciones/);
  });

  it('tipo de hora desconocido', () => {
    const bd = breakdown({ detalle: [{ key: 'raro', horas: 1, factor: 0.1, valor: 100 }] });
    expect(bloqueos(entrada({ slips: [corrida({ bd })] })).join()).toMatch(/«raro»/);
  });

  it('más de 30 días en el mes', () => {
    expect(
      bloqueos(
        entrada({
          slips: [
            corrida({ corridaId: 'q1', dias: 20, rango: { desde: '2026-10-01', hasta: '2026-10-15' } }),
            corrida({ corridaId: 'q2', dias: 20, rango: { desde: '2026-10-16', hasta: '2026-10-31' } }),
          ],
        }),
      ).join(),
    ).toMatch(/30/);
  });

  it('ignora corridas de otros meses', () => {
    const otro = corrida({ corridaId: 'x', periodo: '2026-09', estado: 'borrador' });
    expect(consolidarNominaMes(entrada({ slips: [otro, corrida()] })).ok).toBe(true);
  });
});

describe('consolidarNominaMes: correcciones de revisión', () => {
  it('colilla repetida (mismo corridaId) bloquea', () => {
    expect(bloqueos(entrada({ slips: [corrida(), corrida()] })).join()).toMatch(/viene repetida/);
  });

  it('importes fraccionarios o negativos bloquean', () => {
    const bd = breakdown({});
    bd.deducciones.salud = 60_000.5;
    expect(bloqueos(entrada({ slips: [corrida({ bd })] })).join()).toMatch(/pesos enteros no negativos: salud/);
    const bd2 = breakdown({});
    bd2.devengados.comisiones = -1;
    expect(bloqueos(entrada({ slips: [corrida({ bd: bd2 })] })).join()).toMatch(/comisiones/);
    const bd3 = breakdown({ otras: 10_000 });
    expect(bloqueos(entrada({ slips: [corrida({ bd: bd3, detalleOtras: [{ concept: 'X', amount: 10_000.5 }] })] })).join()).toMatch(
      /deducción «X»/,
    );
  });

  it('el neto negativo se recorta por colilla y devuelve el recorte', () => {
    // Colilla 1: devenga 100.000, deduce 158.000 (exceso 58.000). Colilla 2: sana. El mes sumado no tendría exceso.
    const neg = breakdown({ salario: 100_000, otras: 150_000, ibc: 100_000, salud: 4_000, pension: 4_000 });
    const sana = breakdown({ salario: 1_000_000 });
    const r = ok(
      entrada({
        slips: [
          corrida({
            corridaId: 'q1',
            bd: neg,
            dias: 10,
            rango: { desde: '2026-10-01', hasta: '2026-10-10' },
            detalleOtras: [
              { concept: 'Préstamo', amount: 100_000 },
              { concept: 'Consumo', amount: 50_000 },
            ],
          }),
          corrida({ corridaId: 'q2', bd: sana, dias: 15, rango: { desde: '2026-10-16', hasta: '2026-10-31' } }),
        ],
        deducciones: [
          { employeeId: 'emp1', concept: 'Consumo', amount: 50_000, source: 'sale', appliedRunId: 'q1' },
          { employeeId: 'emp1', concept: 'Préstamo', amount: 100_000, source: 'manual', appliedRunId: 'q1' },
        ],
      }),
    );
    expect(r.recorte).toEqual({ otras: 58_000, deuda: 0, total: 58_000 });
    expect(r.modelo.deducciones.otras).toEqual([4_200_000]);
    expect(r.modelo.deducciones.deuda).toBe(5_000_000);
    expect(r.advertencias.join(' ')).toMatch(/arrastre/);
  });

  it('sin neto negativo el recorte es cero', () => {
    expect(ok(entrada()).recorte).toEqual({ otras: 0, deuda: 0, total: 0 });
  });

  it('el cruce prioriza el mismo origen; sin par avisa explícitamente', () => {
    const bd = breakdown({ otras: 20_000 });
    const dets = [
      { concept: 'Consumo', amount: 10_000, source: 'arrastre' },
      { concept: 'Consumo', amount: 10_000 },
    ];
    const deducciones: DeduccionConsolidar[] = [
      { employeeId: 'emp1', concept: 'Consumo', amount: 10_000, source: 'sale', appliedRunId: 'run1' },
      { employeeId: 'emp1', concept: 'Consumo', amount: 10_000, source: 'arrastre', appliedRunId: 'run1' },
    ];
    const r = ok(entrada({ slips: [corrida({ bd, detalleOtras: dets })], deducciones }));
    expect(r.modelo.deducciones.deuda).toBe(2_000_000);
    expect(r.advertencias).toEqual([]);
    const sinPar = ok(entrada({ slips: [corrida({ bd: breakdown({ otras: 5_000 }), detalleOtras: [{ concept: 'Raro', amount: 5_000 }] })] }));
    expect(sinPar.modelo.deducciones.otras).toEqual([500_000]);
    expect(sinPar.advertencias.join(' ')).toMatch(/no se pudo vincular/);
  });

  it('FSP con IBC 0 bloquea', () => {
    const bd = breakdown({ salario: 1_000_000, ibc: 0, salud: 0, pension: 0, fsp: 5_000 });
    expect(bloqueos(entrada({ slips: [corrida({ bd })] })).join()).toMatch(/FSP.*IBC en 0/);
  });

  it('pensionado por vejez con FSP bloquea', () => {
    const bd = breakdown({ pension: 0, fsp: 5_000 });
    expect(bloqueos(entrada({ slips: [corrida({ bd })], empleado: empleado({ subTipoTrabajador: '01' }) })).join()).toMatch(
      /solidaridad pensional/,
    );
  });

  it('tiempoLaborado360: el último día de febrero cuenta como 30', () => {
    expect(tiempoLaborado360('2026-02-28', '2026-02-28')).toBe(1);
    expect(tiempoLaborado360('2026-02-01', '2026-02-28')).toBe(30);
    expect(tiempoLaborado360('2026-10-16', '2026-10-31')).toBe(15);
  });

  it('el rango debe estar dentro del periodo', () => {
    const r = bloqueos(entrada({ slips: [corrida({ rango: { desde: '2026-09-20', hasta: '2026-10-10' } })] }));
    expect(r.join()).toMatch(/no está dentro de 2026-10/);
  });

  it('el periodo inválido se rechaza antes de calcular fechas', () => {
    expect(bloqueos(entrada({ periodo: '2026-13' })).join()).toMatch(/no es un mes YYYY-MM/);
    expect(bloqueos(entrada({ periodo: 'abc' })).join()).toMatch(/no es un mes/);
  });

  it('fecha de pago anterior al periodo bloquea; muy posterior avisa', () => {
    const conPago = (fecha: string) => entrada({ slips: [corrida({ pago: { medio: '10', fecha } })] });
    expect(bloqueos(conPago('2026-09-30')).join()).toMatch(/anterior al inicio/);
    const r = ok(conPago('2026-12-15'));
    expect(r.advertencias.join()).toMatch(/después del mes siguiente/);
    expect(ok(conPago('2026-11-05')).advertencias).toEqual([]);
  });
});
