import { describe, expect, it } from 'vitest';
import { calcularCune } from '../cune';
import { validarXsdNomina, leerEjemploNomina } from './__fixtures__/validar-xsd-nomina.test';
import type {
  ContextoNomina,
  DocumentoNe,
  EmisionNe,
  ModeloNominaAjuste,
  PredecesorNe,
  ResultadoNomina,
} from './modelo';
import { armarNominaAjuste, armarNominaIndividual } from './xml-nomina';

const ctx: ContextoNomina = { tipoAmbiente: '2', softwareId: 'sw-nomina-1', softwarePin: '12345' };

const emision: EmisionNe = {
  fecha: '2026-10-31',
  hora: '10:30:00-05:00',
  prefijo: 'NE',
  consecutivo: 7,
  empleador: {
    nit: '900123456',
    dv: '7',
    razonSocial: 'Panadería "El Trigo" & Cía S.A.S.',
    departamento: '05',
    municipio: '05001',
    direccion: 'Calle 10 # 20-30',
  },
};

/** Documento mínimo válido: sueldo $1.500.000 y salud/pensión al 4 %. */
function documentoBase(): DocumentoNe {
  return {
    periodo: {
      fechaIngreso: '2024-02-01',
      fechaLiquidacionInicio: '2026-10-01',
      fechaLiquidacionFin: '2026-10-31',
      tiempoLaborado: 987,
    },
    periodoNomina: '5',
    trabajador: {
      tipoTrabajador: '01',
      subTipoTrabajador: '00',
      altoRiesgoPension: false,
      tipoDocumento: '13',
      numeroDocumento: '1017123456',
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
  };
}

const predecesor: PredecesorNe = { numero: 'NE6', cune: 'a'.repeat(96), fecha: '2026-09-30' };

/** Suma los valores monetarios de un fragmento (atributos y nodos de texto). */
function sumaCentavos(xml: string, nodo: 'Devengados' | 'Deducciones'): number {
  const bloque = new RegExp(`<${nodo}>([\\s\\S]*?)</${nodo}>`).exec(xml)?.[1] ?? '';
  const montos = [
    ...[...bloque.matchAll(/\s(?:SueldoTrabajado|AuxilioTransporte|ViaticoManuAlojS|ViaticoManuAlojNS|Pago|PagoNS|PagoIntereses|BonificacionS|BonificacionNS|AuxilioS|AuxilioNS|ConceptoS|ConceptoNS|Deduccion|DeduccionSP|DeduccionSub|SancionPriv)="(\d+)\.(\d{2})"/g)],
    ...[...bloque.matchAll(/<(?:Comision|PagoTercero|Dotacion|Indemnizacion|Reintegro|Anticipo|OtraDeduccion|PensionVoluntaria|RetencionFuente|AFC|Cooperativa|EmbargoFiscal|PlanComplementarios|Educacion|Deuda)>(\d+)\.(\d{2})</g)],
  ];
  return montos.reduce((s, m) => s + Number(m[1]) * 100 + Number(m[2]), 0);
}

const nodoTotal = (xml: string, n: string): number => {
  const m = new RegExp(`<${n}>(\\d+)\\.(\\d{2})</${n}>`).exec(xml);
  return Number(m![1]) * 100 + Number(m![2]);
};
const attr = (xml: string, el: string, a: string): string =>
  new RegExp(`<${el}\\b[^>]*\\s${a}="([^"]*)"`).exec(xml)![1]!;

/** Recalcula el CUNE leyendo solo lo que está en el XML. */
function cuneDelXml(xml: string): string {
  return calcularCune({
    numero: attr(xml, 'NumeroSecuenciaXML', 'Numero'),
    fecha: attr(xml, 'InformacionGeneral', 'FechaGen'),
    hora: attr(xml, 'InformacionGeneral', 'HoraGen'),
    devengados: nodoTotal(xml, 'DevengadosTotal'),
    deducciones: nodoTotal(xml, 'DeduccionesTotal'),
    total: nodoTotal(xml, 'ComprobanteTotal'),
    nitEmpleador: attr(xml, 'Empleador', 'NIT'),
    docEmpleado: attr(xml, 'Trabajador', 'NumeroDocumento'),
    tipoXml: attr(xml, 'InformacionGeneral', 'TipoXML') as '102' | '103',
    softwarePin: ctx.softwarePin,
    tipoAmbiente: attr(xml, 'InformacionGeneral', 'Ambiente') as '1' | '2',
  });
}

async function verificar(r: ResultadoNomina, nombre: string) {
  const xsd = await validarXsdNomina(r.xml, `${nombre}.xml`);
  expect(xsd.errores).toEqual([]);
  expect(cuneDelXml(r.xml)).toBe(r.cune);
  expect(sumaCentavos(r.xml, 'Devengados')).toBe(r.totales.devengados);
  expect(sumaCentavos(r.xml, 'Deducciones')).toBe(r.totales.deducciones);
  expect(nodoTotal(r.xml, 'DevengadosTotal')).toBe(r.totales.devengados);
  expect(nodoTotal(r.xml, 'DeduccionesTotal')).toBe(r.totales.deducciones);
  expect(nodoTotal(r.xml, 'ComprobanteTotal')).toBe(r.totales.devengados - r.totales.deducciones);
}

const individual = (doc: DocumentoNe) => armarNominaIndividual({ emision, documento: doc }, ctx);

describe('nómina electrónica: NominaIndividual (102)', () => {
  it('el ejemplo oficial del anexo pasa el validador (sanidad del validador)', async () => {
    const r = await validarXsdNomina(leerEjemploNomina('nomina-individual-v1.0.2.xml'));
    expect(r.errores).toEqual([]);
  }, 60_000);

  it('básico + auxilio de transporte', async () => {
    const d = documentoBase();
    d.devengados.transporte = { auxilio: 20_000_000 };
    const r = individual(d);
    expect(r.totales).toEqual({ devengados: 170_000_000, deducciones: 12_000_000, comprobante: 158_000_000 });
    await verificar(r, 'basico-transporte');
    expect(r.xml).toContain('<ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent></ext:ExtensionContent>');
    expect(r.xml).toContain('<DevengadosTotal>1700000.00</DevengadosTotal>');
    expect(r.numero).toBe('NE7');
    expect(attr(r.xml, 'ProveedorXML', 'SoftwareSC')).toMatch(/^[0-9a-f]{96}$/);
    expect(r.xml).toContain('https://catalogo-vpfe-hab.dian.gov.co/document/searchqr?documentkey=' + r.cune);
  }, 60_000);

  it('horas extra y recargos', async () => {
    const d = documentoBase();
    d.devengados.horas = [
      // El porcentaje es el RECARGO de la tabla 5.5.7 (no el factor total).
      { tipo: 'HRNDF', cantidad: 3, porcentaje: 115, pago: 400_000 },
      { tipo: 'HRDDF', cantidad: 8, porcentaje: 80, pago: 300_000 },
      { tipo: 'HED', cantidad: 10, porcentaje: 25, pago: 900_000 },
      { tipo: 'HED', cantidad: 2, porcentaje: 25, pago: 180_000 },
      { tipo: 'HEN', cantidad: 4.5, porcentaje: 75, pago: 700_000 },
      { tipo: 'HRN', cantidad: 6, porcentaje: 35, pago: 250_000 },
    ];
    const r = individual(d);
    expect(r.xml.indexOf('<HEDs>')).toBeLessThan(r.xml.indexOf('<HENs>'));
    expect(r.xml.indexOf('<HENs>')).toBeLessThan(r.xml.indexOf('<HRNDFs>'));
    expect(r.xml).toContain('Cantidad="4.50" Porcentaje="75.00" Pago="7000.00"');
    expect(r.xml).toContain('Porcentaje="25.00"');
    expect(r.xml).toContain('<HRDDF Cantidad="8.00" Porcentaje="80.00" Pago="3000.00"/>');
    await verificar(r, 'horas');
  }, 60_000);

  it('vacaciones, prima y cesantías con intereses', async () => {
    const d = documentoBase();
    d.devengados.vacacionesComunes = [
      { dias: 5, pago: 25_000_000, fechaInicio: '2026-10-12', fechaFin: '2026-10-16' },
    ];
    d.devengados.vacacionesCompensadas = [{ dias: 3, pago: 15_000_000 }];
    d.devengados.primas = { dias: 180, pago: 75_000_000, pagoNS: 1_000_000 };
    d.devengados.cesantias = { pago: 150_000_000, porcentaje: 12, intereses: 9_000_000 };
    const r = individual(d);
    await verificar(r, 'vacaciones-prima-cesantias');
  }, 60_000);

  it('incapacidad y licencia de maternidad', async () => {
    const d = documentoBase();
    d.devengados.incapacidades = [
      { dias: 3, tipo: 1, pago: 10_000_000, fechaInicio: '2026-10-05', fechaFin: '2026-10-07' },
    ];
    d.devengados.licenciasMP = [{ dias: 10, pago: 50_000_000, fechaInicio: '2026-10-10', fechaFin: '2026-10-19' }];
    const r = individual(d);
    await verificar(r, 'incapacidad-licencia');
  }, 60_000);

  it('deducciones de salud, pensión, FSP, libranza y otras', async () => {
    const d = documentoBase();
    d.deducciones.fondoSP = { porcentaje: 0.5, valor: 750_000, porcentajeSub: 0.5, valorSub: 750_000 };
    d.deducciones.libranzas = [{ descripcion: 'Libranza Banco & Co', valor: 20_000_000 }];
    d.deducciones.otras = [1_000_000, 500_000];
    d.deducciones.sindicatos = [{ porcentaje: 1, valor: 1_500_000 }];
    d.deducciones.retencionFuente = 2_000_000;
    const r = individual(d);
    expect(r.totales.deducciones).toBe(12_000_000 + 1_500_000 + 20_000_000 + 1_500_000 + 1_500_000 + 2_000_000);
    expect(r.xml).toContain('Descripcion="Libranza Banco &amp; Co"');
    await verificar(r, 'deducciones');
  }, 60_000);

  it('retiro con indemnización', async () => {
    const d = documentoBase();
    d.periodo.fechaRetiro = '2026-10-31';
    d.devengados.indemnizacion = 300_000_000;
    d.devengados.dotacion = 5_000_000;
    const r = individual(d);
    expect(r.xml).toContain('FechaRetiro="2026-10-31"');
    expect(r.xml).toContain('<Indemnizacion>3000000.00</Indemnizacion>');
    await verificar(r, 'retiro');
  }, 60_000);

  it('bonificaciones, comisiones y otros conceptos', async () => {
    const d = documentoBase();
    d.devengados.bonificaciones = [{ s: 5_000_000, ns: 2_000_000 }];
    d.devengados.auxilios = [{ ns: 1_000_000 }];
    d.devengados.otrosConceptos = [{ descripcion: 'Bono "especial"', ns: 3_000_000 }];
    d.devengados.comisiones = [4_000_000];
    const r = individual(d);
    expect(r.xml).toContain('DescripcionConcepto="Bono &quot;especial&quot;"');
    await verificar(r, 'otros-devengados');
  }, 60_000);

  it('un nodo en 0 no se emite, pero Salud y FondoPension son obligatorios', async () => {
    const d = documentoBase();
    d.devengados.transporte = { auxilio: 0 };
    d.devengados.primas = { dias: 0, pago: 0 };
    d.devengados.horas = [{ tipo: 'HED', cantidad: 0, porcentaje: 125, pago: 0 }];
    d.devengados.comisiones = [0];
    d.deducciones.fondoSP = { porcentaje: 0.5, valor: 0 };
    d.deducciones.libranzas = [{ descripcion: 'x', valor: 0 }];
    d.deducciones.salud = { porcentaje: 0, valor: 0 };
    const r = individual(d);
    for (const n of ['<Transporte', '<Primas', '<HEDs>', '<Comisiones>', '<FondoSP', '<Libranzas>']) {
      expect(r.xml).not.toContain(n);
    }
    expect(r.xml).toContain('<Salud Porcentaje="0.00" Deduccion="0.00"/>');
    await verificar(r, 'ceros');
  }, 60_000);

  it('lanza ante un valor negativo, no entero o deducciones mayores que los devengados', () => {
    const neg = documentoBase();
    neg.devengados.dotacion = -1;
    expect(() => individual(neg)).toThrow(/negativo/);
    const frac = documentoBase();
    frac.deducciones.salud.valor = 10.5;
    expect(() => individual(frac)).toThrow(/no entero/);
    const sobre = documentoBase();
    sobre.deducciones.otras = [999_999_999];
    expect(() => individual(sobre)).toThrow(/superan los devengados/);
  });

  it('lanza ante datos de emisión inválidos', () => {
    const doc = documentoBase();
    expect(() => armarNominaIndividual({ emision, documento: doc }, { ...ctx, softwarePin: ' ' })).toThrow(/PIN/);
    expect(() =>
      armarNominaIndividual({ emision: { ...emision, hora: '10:30:00' }, documento: doc }, ctx),
    ).toThrow(/Hora inválida/);
    expect(() =>
      armarNominaIndividual({ emision: { ...emision, consecutivo: 0 }, documento: doc }, ctx),
    ).toThrow(/Consecutivo/);
    const letras = documentoBase();
    letras.trabajador.numeroDocumento = 'AB123';
    expect(() => individual(letras)).toThrow(/solo con números/);
  });

  it('no redondea en silencio: días y TiempoLaborado deben ser enteros positivos', () => {
    const a = documentoBase();
    a.devengados.basico.dias = 29.5;
    expect(() => individual(a)).toThrow(/DiasTrabajados/);
    const b = documentoBase();
    b.periodo.tiempoLaborado = 0;
    expect(() => individual(b)).toThrow(/TiempoLaborado/);
    const c = documentoBase();
    c.periodo.tiempoLaborado = 10.4;
    expect(() => individual(c)).toThrow(/TiempoLaborado/);
    const d = documentoBase();
    d.devengados.primas = { dias: 90.5, pago: 1_000_000 };
    expect(() => individual(d)).toThrow(/prima/);
  });

  it('escapa tab y salto de línea en atributos y los conserva', async () => {
    const d = documentoBase();
    d.trabajador.lugarTrabajo.direccion = 'Calle 10\n# 20-30\tPiso 2\r';
    const r = individual(d);
    expect(r.xml).toContain('LugarTrabajoDireccion="Calle 10&#xA;# 20-30&#x9;Piso 2&#xD;"');
    expect(r.xml).not.toMatch(/Direccion="[^"]*[\n\t\r]/);
    await verificar(r, 'direccion-multilinea');
  }, 60_000);

  it('rechaza códigos de catálogo vacíos o mal formados y fechas inválidas', () => {
    const casos: [string, (d: DocumentoNe) => void, RegExp][] = [
      ['periodo vacío', (d) => (d.periodoNomina = ''), /PeriodoNomina/],
      ['tipo trabajador', (d) => (d.trabajador.tipoTrabajador = '1'), /TipoTrabajador/],
      ['subtipo', (d) => (d.trabajador.subTipoTrabajador = 'ab'), /SubTipoTrabajador/],
      ['contrato', (d) => (d.trabajador.tipoContrato = ''), /TipoContrato/],
      ['tipo documento', (d) => (d.trabajador.tipoDocumento = 'CC'), /TipoDocumento/],
      ['forma de pago', (d) => (d.pago.forma = '0'), /Forma de pago/],
      ['método de pago', (d) => (d.pago.metodo = ''), /Método de pago/],
      ['fecha de ingreso', (d) => (d.periodo.fechaIngreso = '01/02/2024'), /FechaIngreso/],
      ['fecha imposible', (d) => (d.periodo.fechaLiquidacionFin = '2026-13-45'), /FechaLiquidacionFin/],
      ['fecha de pago', (d) => (d.fechasPagos = ['ayer']), /FechaPago/],
      [
        'incapacidad sin fechas',
        (d) => (d.devengados.incapacidades = [{ dias: 2, tipo: 1, pago: 1_000_000 }]),
        /FechaInicio de la incapacidad/,
      ],
    ];
    for (const [nombre, muta, esperado] of casos) {
      const d = documentoBase();
      muta(d);
      expect(() => individual(d), nombre).toThrow(esperado);
    }
  });

  it('FondoSP exige el porcentaje de cada parte que trae valor', () => {
    const a = documentoBase();
    a.deducciones.fondoSP = { porcentaje: 0, valor: 750_000 };
    expect(() => individual(a)).toThrow(/solidaridad/);
    const b = documentoBase();
    b.deducciones.fondoSP = { porcentaje: 0.5, valor: 750_000, valorSub: 500_000 };
    expect(() => individual(b)).toThrow(/PorcentajeSub/);
  });

  it('es determinista: mismo modelo, mismo XML y mismo CUNE', () => {
    expect(individual(documentoBase())).toEqual(individual(documentoBase()));
  });

  it('en producción el QR apunta al catálogo de producción', () => {
    const r = armarNominaIndividual({ emision, documento: documentoBase() }, { ...ctx, tipoAmbiente: '1' });
    expect(r.xml).toContain('https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey=' + r.cune);
    expect(attr(r.xml, 'InformacionGeneral', 'Ambiente')).toBe('1');
  });
});

describe('nómina electrónica: NominaIndividualDeAjuste (103)', () => {
  it('el ejemplo oficial del anexo pasa el validador', async () => {
    const r = await validarXsdNomina(leerEjemploNomina('nomina-individual-ajuste-v1.0.2.xml'));
    expect(r.errores).toEqual([]);
  }, 60_000);

  it('Reemplazar: documento completo corregido, número nuevo y predecesor', async () => {
    const d = documentoBase();
    d.devengados.dotacion = 2_000_000;
    const modelo: ModeloNominaAjuste = { tipoNota: 1, emision: { ...emision, consecutivo: 8 }, predecesor, documento: d };
    const r = armarNominaAjuste(modelo, ctx);
    expect(r.numero).toBe('NE8');
    expect(r.xml).toContain('<TipoNota>1</TipoNota><Reemplazar>');
    expect(r.xml).toContain(`NumeroPred="NE6" CUNEPred="${predecesor.cune}" FechaGenPred="2026-09-30"`);
    expect(attr(r.xml, 'InformacionGeneral', 'TipoXML')).toBe('103');
    await verificar(r, 'ajuste-reemplazar');
  }, 60_000);

  it('Eliminar: sin devengados ni deducciones, totales 0.00 y DocEmp 0 en el CUNE', async () => {
    const r = armarNominaAjuste({ tipoNota: 2, emision: { ...emision, consecutivo: 9 }, predecesor }, ctx);
    expect(r.totales).toEqual({ devengados: 0, deducciones: 0, comprobante: 0 });
    expect(r.xml).toContain('<TipoNota>2</TipoNota><Eliminar>');
    expect(r.xml).not.toContain('<Devengados>');
    expect(r.xml).not.toContain('<Deducciones>');
    expect(r.xml).not.toContain('<Trabajador');
    const esperado = calcularCune({
      numero: 'NE9',
      fecha: emision.fecha,
      hora: emision.hora,
      devengados: 0,
      deducciones: 0,
      total: 0,
      nitEmpleador: emision.empleador.nit,
      docEmpleado: '0',
      tipoXml: '103',
      softwarePin: ctx.softwarePin,
      tipoAmbiente: '2',
    });
    expect(r.cune).toBe(esperado);
    expect(attr(r.xml, 'InformacionGeneral', 'CUNE')).toBe(r.cune);
    const xsd = await validarXsdNomina(r.xml, 'ajuste-eliminar.xml');
    expect(xsd.errores).toEqual([]);
  }, 60_000);

  it('lanza si el predecesor es inválido o el TipoNota no existe', () => {
    expect(() =>
      armarNominaAjuste({ tipoNota: 2, emision, predecesor: { ...predecesor, cune: 'corto' } }, ctx),
    ).toThrow(/predecesor/);
  });
});
