import { calcularCune, calcularCuneEliminar } from '../cune';
import { assertFechaHoraDian, dianVerificationUrl } from '../cufe';
import { aCentavos, formatearMontoDian, type Centavos } from '../redondeo';
import { codigoSeguridadSoftware } from '../ubl/factura-ubl';
import { DocumentoUblInvalidoError, esc } from '../ubl/xml-ubl';
import {
  TIPOS_HORA_NE,
  TipoNota,
  type ContextoNomina,
  type DeduccionesNe,
  type DevengadosNe,
  type DiasPagoNe,
  type DocumentoNe,
  type EmisionNe,
  type ModeloNominaAjuste,
  type ModeloNominaIndividual,
  type PredecesorNe,
  type ResultadoNomina,
  type SalarialNe,
} from './modelo';

/**
 * Armador del XML de la nómina electrónica (anexo técnico V1.0, Res. DIAN
 * 000013 de 2021; XSD 1.0.6): NominaIndividual (102) y NominaIndividualDeAjuste
 * (103, Reemplazar y Eliminar). Función pura, sin reloj: la fecha y la hora
 * vienen en el modelo. Devuelve el XML SIN firmar, con el slot de firma
 * (`ext:UBLExtensions` con una `ext:UBLExtension` vacía) como en la factura.
 *
 * Garantías por construcción:
 * - Los totales son la SUMA de los montos que se escriben en el XML (centavos
 *   enteros, `formatearMontoDian`) y esos mismos valores alimentan el CUNE.
 * - Ningún valor negativo (lanza) y un nodo opcional en 0 no se emite (VLR01).
 * - Los nodos van en el orden del XSD.
 *
 * Las reglas NIE/NIAE del anexo (catálogos, cuadre contra la PILA) solo las
 * confirma el set de pruebas de la DIAN; el XSD y el CUNE los cubren los tests.
 */

const NS = {
  '102': 'dian:gov:co:facturaelectronica:NominaIndividual',
  '103': 'dian:gov:co:facturaelectronica:NominaIndividualDeAjuste',
} as const;

const VERSION = {
  '102': 'V1.0: Documento Soporte de Pago de Nómina Electrónica',
  '103': 'V1.0: Nota de Ajuste de Documento Soporte de Pago de Nómina Electrónica',
} as const;

/** Namespaces del ejemplo oficial. */
const NS_COMUNES =
  'xmlns:xs="http://www.w3.org/2001/XMLSchema-instance" xmlns:ds="http://www.w3.org/2000/09/xmldsig#"' +
  ' xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"' +
  ' xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" xmlns:xades141="http://uri.etsi.org/01903/v1.4.1#"' +
  ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';

const DECLARACION = '<?xml version="1.0" encoding="UTF-8"?>';

function abrirRaiz(tipo: '102' | '103'): string {
  const raiz = tipo === '102' ? 'NominaIndividual' : 'NominaIndividualDeAjuste';
  return (
    `<${raiz} xmlns="${NS[tipo]}" ${NS_COMUNES} SchemaLocation=""` +
    ` xsi:schemaLocation="${NS[tipo]} ${raiz}ElectronicaXSD.xsd">` +
    // Slot de la firma XAdES: lo llena el firmador, aquí va vacío.
    '<ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent></ext:ExtensionContent></ext:UBLExtension></ext:UBLExtensions>'
  );
}

// ── Serialización ──────────────────────────────────────────────────────────

type Attrs = Record<string, string | number | boolean | undefined>;

/** Escape de un valor de atributo: el de contenido más las comillas dobles. */
const escAttr = (s: string) =>
  esc(s)
    .replace(/"/g, '&quot;')
    // Un tab o salto de línea crudo en un atributo se normaliza a espacio al parsear: se escapa para conservarlo.
    .replace(/\t/g, '&#x9;')
    .replace(/\n/g, '&#xA;')
    .replace(/\r/g, '&#xD;');

function el(nombre: string, attrs: Attrs = {}, hijos = ''): string {
  const a = Object.entries(attrs)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${escAttr(String(v))}"`)
    .join('');
  return hijos ? `<${nombre}${a}>${hijos}</${nombre}>` : `<${nombre}${a}/>`;
}

/** Contenedor que solo existe si tiene hijos. */
const grupo = (nombre: string, hijos: string[]) => (hijos.length ? `<${nombre}>${hijos.join('')}</${nombre}>` : '');

const pct = (n: number) => {
  if (!Number.isFinite(n) || n < 0) throw new DocumentoUblInvalidoError(`Porcentaje inválido en la nómina: ${n}`);
  return formatearMontoDian(aCentavos(n));
};
const cant = (n: number) => {
  if (!Number.isFinite(n) || n < 0) throw new DocumentoUblInvalidoError(`Cantidad inválida en la nómina: ${n}`);
  return formatearMontoDian(aCentavos(n));
};
/** Días o cantidad entera: no se redondea en silencio, un decimal es un error del consolidador. */
const entero = (n: number, que: string) => {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new DocumentoUblInvalidoError(`${que} debe ser un entero no negativo y llegó ${String(n)}`);
  }
  return n;
};

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
function assertFecha(f: string | undefined, que: string): void {
  // Date.parse acepta días inexistentes (2026-02-31 → 3 de marzo): se exige ida y vuelta.
  const ms = f === undefined ? NaN : Date.parse(`${f}T00:00:00Z`);
  if (f === undefined || !FECHA.test(f) || Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== f) {
    throw new DocumentoUblInvalidoError(`${que} debe ser una fecha YYYY-MM-DD y llegó «${String(f)}»`);
  }
}
function assertCodigo(v: string, formato: RegExp, que: string): void {
  if (typeof v !== 'string' || !formato.test(v)) {
    throw new DocumentoUblInvalidoError(`${que} no es un código válido de la tabla del anexo: «${String(v)}»`);
  }
}

function assertMonto(c: Centavos): void {
  if (!Number.isSafeInteger(c) || c < 0) {
    throw new DocumentoUblInvalidoError(`Valor negativo o no entero en la nómina electrónica: ${String(c)}`);
  }
}

const positivo = (c: Centavos | undefined): c is Centavos => {
  if (c === undefined) return false;
  assertMonto(c);
  return c > 0;
};

/** Acumula en centavos lo que se escribe: el total es la suma de los textos del XML. */
function sumador() {
  let total = 0;
  return {
    /** Escribe un monto y lo suma. */
    m(c: Centavos): string {
      assertMonto(c);
      total += c;
      return formatearMontoDian(c);
    },
    /** Opcional: undefined si es 0 (el atributo no se escribe). */
    o(c: Centavos | undefined): string | undefined {
      return positivo(c) ? this.m(c) : undefined;
    },
    get centavos() {
      return total;
    },
  };
}
type Sumador = ReturnType<typeof sumador>;

// ── Devengados y deducciones ───────────────────────────────────────────────

function salariales(nombre: string, s: string, ns: string, items: SalarialNe[], dev: Sumador): string[] {
  return items
    .filter((i) => positivo(i.s) || positivo(i.ns))
    .map((i) => el(nombre, { [s]: dev.o(i.s), [ns]: dev.o(i.ns) }));
}

const valores = (nombre: string, items: Centavos[], sum: Sumador) =>
  items.filter(positivo).map((v) => `<${nombre}>${sum.m(v)}</${nombre}>`);

const simple = (nombre: string, v: Centavos | undefined, sum: Sumador) =>
  positivo(v) ? `<${nombre}>${sum.m(v)}</${nombre}>` : '';

function devengadosXml(d: DevengadosNe, dev: Sumador): string {
  const t = d.transporte;
  const horas = TIPOS_HORA_NE.map((tipo) =>
    grupo(
      `${tipo}s`,
      d.horas
        .filter((h) => h.tipo === tipo && positivo(h.pago))
        .map((h) => el(tipo, { Cantidad: cant(h.cantidad), Porcentaje: pct(h.porcentaje), Pago: dev.m(h.pago) })),
    ),
  );
  const diasPago = (nombre: string, items: DiasPagoNe[], conFechas: boolean) =>
    items
      .filter((v) => positivo(v.pago))
      .map((v) => {
        if (conFechas) {
          assertFecha(v.fechaInicio, `FechaInicio de ${nombre}`);
          assertFecha(v.fechaFin, `FechaFin de ${nombre}`);
        }
        return el(nombre, {
          ...(conFechas ? { FechaInicio: v.fechaInicio, FechaFin: v.fechaFin } : {}),
          Cantidad: entero(v.dias, `Días de ${nombre}`),
          Pago: dev.m(v.pago),
        });
      });
  const p = d.primas;
  const c = d.cesantias;
  return [
    el('Basico', { DiasTrabajados: entero(d.basico.dias, 'DiasTrabajados'), SueldoTrabajado: dev.m(d.basico.sueldo) }),
    t && (positivo(t.auxilio) || positivo(t.viaticoS) || positivo(t.viaticoNS))
      ? el('Transporte', {
          AuxilioTransporte: dev.o(t.auxilio),
          ViaticoManuAlojS: dev.o(t.viaticoS),
          ViaticoManuAlojNS: dev.o(t.viaticoNS),
        })
      : '',
    ...horas,
    grupo('Vacaciones', [
      ...diasPago('VacacionesComunes', d.vacacionesComunes, true),
      ...diasPago('VacacionesCompensadas', d.vacacionesCompensadas, false),
    ]),
    p && (positivo(p.pago) || positivo(p.pagoNS))
      ? el('Primas', { Cantidad: entero(p.dias, 'Días de la prima'), Pago: dev.m(p.pago), PagoNS: dev.o(p.pagoNS) })
      : '',
    c && (positivo(c.pago) || positivo(c.intereses))
      ? el('Cesantias', { Pago: dev.m(c.pago), Porcentaje: pct(c.porcentaje), PagoIntereses: dev.m(c.intereses) })
      : '',
    grupo(
      'Incapacidades',
      d.incapacidades
        .filter((i) => positivo(i.pago))
        .map((i) => {
          assertFecha(i.fechaInicio, 'FechaInicio de la incapacidad');
          assertFecha(i.fechaFin, 'FechaFin de la incapacidad');
          return el('Incapacidad', {
            FechaInicio: i.fechaInicio,
            FechaFin: i.fechaFin,
            Cantidad: entero(i.dias, 'Días de la incapacidad'),
            Tipo: i.tipo,
            Pago: dev.m(i.pago),
          });
        }),
    ),
    grupo('Licencias', [
      ...diasPago('LicenciaMP', d.licenciasMP, true),
      ...diasPago('LicenciaR', d.licenciasR ?? [], true),
      // La no remunerada no lleva Pago: se escribe si tiene días.
      ...(d.licenciasNR ?? [])
        .filter((v) => v.dias > 0)
        .map((v) => {
          assertFecha(v.fechaInicio, 'FechaInicio de LicenciaNR');
          assertFecha(v.fechaFin, 'FechaFin de LicenciaNR');
          return el('LicenciaNR', { FechaInicio: v.fechaInicio, FechaFin: v.fechaFin, Cantidad: entero(v.dias, 'Días de LicenciaNR') });
        }),
    ]),
    grupo('Bonificaciones', salariales('Bonificacion', 'BonificacionS', 'BonificacionNS', d.bonificaciones, dev)),
    grupo('Auxilios', salariales('Auxilio', 'AuxilioS', 'AuxilioNS', d.auxilios, dev)),
    grupo(
      'OtrosConceptos',
      d.otrosConceptos
        .filter((o) => positivo(o.s) || positivo(o.ns))
        .map((o) =>
          el('OtroConcepto', { DescripcionConcepto: o.descripcion, ConceptoS: dev.o(o.s), ConceptoNS: dev.o(o.ns) }),
        ),
    ),
    grupo('Comisiones', valores('Comision', d.comisiones, dev)),
    grupo('PagosTerceros', valores('PagoTercero', d.pagosTerceros, dev)),
    simple('Dotacion', d.dotacion, dev),
    simple('Indemnizacion', d.indemnizacion, dev),
    simple('Reintegro', d.reintegro, dev),
  ].join('');
}

function deduccionesXml(d: DeduccionesNe, ded: Sumador): string {
  const fsp = d.fondoSP;
  if (fsp && positivo(fsp.valor) && !(fsp.porcentaje > 0)) {
    throw new DocumentoUblInvalidoError('FondoSP: la deducción de solidaridad necesita su porcentaje.');
  }
  if (fsp && positivo(fsp.valorSub) && !(fsp.porcentajeSub !== undefined && fsp.porcentajeSub > 0)) {
    throw new DocumentoUblInvalidoError('FondoSP: la deducción de subsistencia necesita su porcentaje (PorcentajeSub).');
  }
  return [
    el('Salud', { Porcentaje: pct(d.salud.porcentaje), Deduccion: ded.m(d.salud.valor) }),
    el('FondoPension', { Porcentaje: pct(d.fondoPension.porcentaje), Deduccion: ded.m(d.fondoPension.valor) }),
    fsp && (positivo(fsp.valor) || positivo(fsp.valorSub))
      ? el('FondoSP', {
          Porcentaje: positivo(fsp.valor) ? pct(fsp.porcentaje) : undefined,
          DeduccionSP: ded.o(fsp.valor),
          PorcentajeSub: positivo(fsp.valorSub) && fsp.porcentajeSub !== undefined ? pct(fsp.porcentajeSub) : undefined,
          DeduccionSub: ded.o(fsp.valorSub),
        })
      : '',
    grupo(
      'Sindicatos',
      d.sindicatos
        .filter((s) => positivo(s.valor))
        .map((s) => el('Sindicato', { Porcentaje: pct(s.porcentaje), Deduccion: ded.m(s.valor) })),
    ),
    grupo(
      'Sanciones',
      d.sanciones.filter(positivo).map((v) => el('Sancion', { SancionPublic: '0.00', SancionPriv: ded.m(v) })),
    ),
    grupo(
      'Libranzas',
      d.libranzas
        .filter((l) => positivo(l.valor))
        .map((l) => el('Libranza', { Descripcion: l.descripcion, Deduccion: ded.m(l.valor) })),
    ),
    grupo('PagosTerceros', valores('PagoTercero', d.pagosTerceros, ded)),
    grupo('Anticipos', valores('Anticipo', d.anticipos, ded)),
    grupo('OtrasDeducciones', valores('OtraDeduccion', d.otras, ded)),
    simple('PensionVoluntaria', d.pensionVoluntaria, ded),
    simple('RetencionFuente', d.retencionFuente, ded),
    simple('AFC', d.afc, ded),
    simple('Cooperativa', d.cooperativa, ded),
    simple('EmbargoFiscal', d.embargoFiscal, ded),
    simple('PlanComplementarios', d.planComplementarios, ded),
    simple('Educacion', d.educacion, ded),
    simple('Reintegro', d.reintegro, ded),
    simple('Deuda', d.deuda, ded),
  ].join('');
}

// ── Cabecera común ─────────────────────────────────────────────────────────

/** Valida emisión y contexto; devuelve el número (prefijo + consecutivo). */
function validarEmision(em: EmisionNe, ctx: ContextoNomina): string {
  const e = em.empleador;
  if (!ctx.softwareId.trim() || !ctx.softwarePin.trim()) {
    throw new DocumentoUblInvalidoError('Falta el SoftwareID o el PIN del software de nómina electrónica.');
  }
  if (ctx.tipoAmbiente !== '1' && ctx.tipoAmbiente !== '2') {
    throw new DocumentoUblInvalidoError(`Tipo de ambiente inválido: «${String(ctx.tipoAmbiente)}»`);
  }
  if (!/^\d{5,15}$/.test(e.nit) || !/^\d$/.test(e.dv)) {
    throw new DocumentoUblInvalidoError('El NIT del empleador va sin puntos ni guiones y con el DV aparte.');
  }
  if (!/^\d{2}$/.test(e.departamento) || !/^\d{5}$/.test(e.municipio) || !e.municipio.startsWith(e.departamento)) {
    throw new DocumentoUblInvalidoError(
      'El domicilio del empleador necesita un municipio DANE de 5 dígitos y su departamento.',
    );
  }
  if (!e.direccion.trim() || !e.razonSocial.trim()) {
    throw new DocumentoUblInvalidoError('Falta la razón social o la dirección del empleador.');
  }
  if (!/^[A-Za-z0-9]{0,10}$/.test(em.prefijo)) {
    throw new DocumentoUblInvalidoError('El prefijo de la nómina electrónica va sin espacios ni guiones.');
  }
  if (!Number.isSafeInteger(em.consecutivo) || em.consecutivo < 1) {
    throw new DocumentoUblInvalidoError('Consecutivo de nómina inválido.');
  }
  try {
    assertFechaHoraDian(em.fecha, em.hora);
  } catch (err) {
    throw new DocumentoUblInvalidoError((err as Error).message);
  }
  return `${em.prefijo}${em.consecutivo}`;
}

const numeroSecuencia = (em: EmisionNe, numero: string) =>
  el('NumeroSecuenciaXML', { Prefijo: em.prefijo || undefined, Consecutivo: em.consecutivo, Numero: numero });

const lugarGeneracion = (em: EmisionNe) =>
  el('LugarGeneracionXML', {
    Pais: 'CO',
    DepartamentoEstado: em.empleador.departamento,
    MunicipioCiudad: em.empleador.municipio,
    Idioma: 'es',
  });

const proveedorYQr = (em: EmisionNe, ctx: ContextoNomina, numero: string, cune: string) =>
  el('ProveedorXML', {
    RazonSocial: em.empleador.razonSocial,
    NIT: em.empleador.nit,
    DV: em.empleador.dv,
    SoftwareID: ctx.softwareId,
    SoftwareSC: codigoSeguridadSoftware(ctx.softwareId, ctx.softwarePin, numero),
  }) + `<CodigoQR>${esc(dianVerificationUrl(cune, ctx.tipoAmbiente))}</CodigoQR>`;

const empleadorXml = (em: EmisionNe) =>
  el('Empleador', {
    RazonSocial: em.empleador.razonSocial,
    NIT: em.empleador.nit,
    DV: em.empleador.dv,
    Pais: 'CO',
    DepartamentoEstado: em.empleador.departamento,
    MunicipioCiudad: em.empleador.municipio,
    Direccion: em.empleador.direccion,
  });

const informacionGeneral = (
  tipoXml: '102' | '103',
  em: EmisionNe,
  ctx: ContextoNomina,
  cune: string,
  periodoNomina?: string,
) =>
  el('InformacionGeneral', {
    Version: VERSION[tipoXml],
    Ambiente: ctx.tipoAmbiente,
    TipoXML: tipoXml,
    CUNE: cune,
    EncripCUNE: 'CUNE-SHA384',
    FechaGen: em.fecha,
    HoraGen: em.hora,
    PeriodoNomina: periodoNomina,
    TipoMoneda: periodoNomina === undefined ? undefined : 'COP',
  });

/** Códigos de catálogo con formato y fechas YYYY-MM-DD: los valores de la tabla los confirma la DIAN. */
function validarCatalogosYFechas(doc: DocumentoNe): void {
  const t = doc.trabajador;
  assertCodigo(doc.periodoNomina, /^[1-9]\d?$/, 'PeriodoNomina');
  assertCodigo(t.tipoTrabajador, /^\d{2}$/, 'TipoTrabajador');
  assertCodigo(t.subTipoTrabajador, /^\d{2}$/, 'SubTipoTrabajador');
  assertCodigo(t.tipoContrato, /^[1-9]$/, 'TipoContrato');
  assertCodigo(t.tipoDocumento, /^\d{2}$/, 'TipoDocumento');
  assertCodigo(doc.pago.forma, /^[1-9]$/, 'Forma de pago');
  assertCodigo(doc.pago.metodo, /^\d{1,3}$/, 'Método de pago');
  const p = doc.periodo;
  assertFecha(p.fechaIngreso, 'FechaIngreso');
  if (p.fechaRetiro !== undefined) assertFecha(p.fechaRetiro, 'FechaRetiro');
  assertFecha(p.fechaLiquidacionInicio, 'FechaLiquidacionInicio');
  assertFecha(p.fechaLiquidacionFin, 'FechaLiquidacionFin');
  doc.fechasPagos.forEach((f, i) => assertFecha(f, `FechaPago[${i}]`));
}

// ── Documento completo (102 y cuerpo del Reemplazar) ───────────────────────

function tiempoLaborado(n: number): number {
  const v = entero(n, 'TiempoLaborado');
  if (v < 1) throw new DocumentoUblInvalidoError('TiempoLaborado debe ser de al menos 1 día.');
  return v;
}

function cuerpoCompleto(doc: DocumentoNe, em: EmisionNe, ctx: ContextoNomina, tipoXml: '102' | '103'): ResultadoNomina {
  const numero = validarEmision(em, ctx);
  const t = doc.trabajador;
  if (!/^\d+$/.test(t.numeroDocumento)) {
    throw new DocumentoUblInvalidoError(
      'El documento del trabajador va solo con números: la DIAN lo recibe como entero.',
    );
  }
  if (doc.fechasPagos.length === 0) {
    throw new DocumentoUblInvalidoError('El documento necesita al menos una fecha de pago.');
  }
  validarCatalogosYFechas(doc);
  assertMonto(t.sueldo);

  const dev = sumador();
  const ded = sumador();
  const devengados = devengadosXml(doc.devengados, dev);
  const deducciones = deduccionesXml(doc.deducciones, ded);
  const neto = dev.centavos - ded.centavos;
  if (neto < 0) {
    throw new DocumentoUblInvalidoError(
      'Las deducciones superan los devengados: el comprobante de nómina no puede ser negativo.',
    );
  }
  const totales = { devengados: dev.centavos, deducciones: ded.centavos, comprobante: neto };
  const cune = calcularCune({
    numero,
    fecha: em.fecha,
    hora: em.hora,
    devengados: totales.devengados,
    deducciones: totales.deducciones,
    total: totales.comprobante,
    nitEmpleador: em.empleador.nit,
    docEmpleado: t.numeroDocumento,
    tipoXml,
    softwarePin: ctx.softwarePin,
    tipoAmbiente: ctx.tipoAmbiente,
  });

  const p = doc.periodo;
  const xml = [
    el('Periodo', {
      FechaIngreso: p.fechaIngreso,
      FechaRetiro: p.fechaRetiro,
      FechaLiquidacionInicio: p.fechaLiquidacionInicio,
      FechaLiquidacionFin: p.fechaLiquidacionFin,
      TiempoLaborado: tiempoLaborado(p.tiempoLaborado),
      FechaGen: em.fecha,
    }),
    numeroSecuencia(em, numero),
    lugarGeneracion(em),
    proveedorYQr(em, ctx, numero, cune),
    informacionGeneral(tipoXml, em, ctx, cune, doc.periodoNomina),
    empleadorXml(em),
    el('Trabajador', {
      TipoTrabajador: t.tipoTrabajador,
      SubTipoTrabajador: t.subTipoTrabajador,
      AltoRiesgoPension: t.altoRiesgoPension,
      TipoDocumento: t.tipoDocumento,
      NumeroDocumento: t.numeroDocumento,
      PrimerApellido: t.primerApellido,
      SegundoApellido: t.segundoApellido,
      PrimerNombre: t.primerNombre,
      OtrosNombres: t.otrosNombres || undefined,
      LugarTrabajoPais: 'CO',
      LugarTrabajoDepartamentoEstado: t.lugarTrabajo.departamento,
      LugarTrabajoMunicipioCiudad: t.lugarTrabajo.municipio,
      LugarTrabajoDireccion: t.lugarTrabajo.direccion,
      SalarioIntegral: t.salarioIntegral,
      TipoContrato: t.tipoContrato,
      Sueldo: formatearMontoDian(t.sueldo),
    }),
    el('Pago', {
      Forma: doc.pago.forma,
      Metodo: doc.pago.metodo,
      Banco: doc.pago.banco,
      TipoCuenta: doc.pago.tipoCuenta,
      NumeroCuenta: doc.pago.numeroCuenta,
    }),
    `<FechasPagos>${doc.fechasPagos.map((f) => `<FechaPago>${esc(f)}</FechaPago>`).join('')}</FechasPagos>`,
    `<Devengados>${devengados}</Devengados>`,
    `<Deducciones>${deducciones}</Deducciones>`,
    `<DevengadosTotal>${formatearMontoDian(dev.centavos)}</DevengadosTotal>`,
    `<DeduccionesTotal>${formatearMontoDian(ded.centavos)}</DeduccionesTotal>`,
    `<ComprobanteTotal>${formatearMontoDian(neto)}</ComprobanteTotal>`,
  ].join('');
  return { xml, numero, cune, totales };
}

/** NominaIndividual (TipoXML 102): el documento mensual de un trabajador. */
export function armarNominaIndividual(modelo: ModeloNominaIndividual, ctx: ContextoNomina): ResultadoNomina {
  const c = cuerpoCompleto(modelo.documento, modelo.emision, ctx, '102');
  return { ...c, xml: `${DECLARACION}${abrirRaiz('102')}${c.xml}</NominaIndividual>` };
}

const predecesorAttrs = (p: PredecesorNe) => ({ NumeroPred: p.numero, CUNEPred: p.cune, FechaGenPred: p.fecha });

function assertPredecesor(p: PredecesorNe): void {
  assertFecha(p.fecha, 'La fecha del predecesor');
  if (!p.numero.trim() || !/^[0-9a-f]{96}$/i.test(p.cune)) {
    throw new DocumentoUblInvalidoError(
      'El predecesor del ajuste necesita número, CUNE (SHA-384, 96 hex) y fecha YYYY-MM-DD.',
    );
  }
}

/**
 * NominaIndividualDeAjuste (TipoXML 103). Reemplazar (TipoNota 1): el documento
 * completo corregido con número nuevo y el predecesor. Eliminar (TipoNota 2):
 * solo cabecera y predecesor, sin devengados ni deducciones; el CUNE sale con
 * totales en 0.00 y DocEmp 0 (anexo §8.1.1.4).
 */
export function armarNominaAjuste(modelo: ModeloNominaAjuste, ctx: ContextoNomina): ResultadoNomina {
  assertPredecesor(modelo.predecesor);
  const em = modelo.emision;
  if (modelo.tipoNota === TipoNota.Reemplazar) {
    const c = cuerpoCompleto(modelo.documento, em, ctx, '103');
    const xml =
      `${DECLARACION}${abrirRaiz('103')}<TipoNota>${TipoNota.Reemplazar}</TipoNota><Reemplazar>` +
      `${el('ReemplazandoPredecesor', predecesorAttrs(modelo.predecesor))}${c.xml}</Reemplazar></NominaIndividualDeAjuste>`;
    return { ...c, xml };
  }
  // Defensa en tiempo de ejecución: un TipoNota inesperado (3, o "1" en texto
  // desde la base o la API) NUNCA debe caer en Eliminar y anular el predecesor.
  if ((modelo.tipoNota as unknown) !== TipoNota.Eliminar) {
    throw new DocumentoUblInvalidoError(
      `TipoNota inválido para el ajuste de nómina: «${String(modelo.tipoNota)}» (1 Reemplazar, 2 Eliminar).`,
    );
  }
  const numero = validarEmision(em, ctx);
  const cune = calcularCuneEliminar({
    numero,
    fecha: em.fecha,
    hora: em.hora,
    nitEmpleador: em.empleador.nit,
    softwarePin: ctx.softwarePin,
    tipoAmbiente: ctx.tipoAmbiente,
  });
  const xml =
    `${DECLARACION}${abrirRaiz('103')}<TipoNota>${TipoNota.Eliminar}</TipoNota><Eliminar>` +
    el('EliminandoPredecesor', predecesorAttrs(modelo.predecesor)) +
    numeroSecuencia(em, numero) +
    lugarGeneracion(em) +
    proveedorYQr(em, ctx, numero, cune) +
    informacionGeneral('103', em, ctx, cune) +
    empleadorXml(em) +
    '</Eliminar></NominaIndividualDeAjuste>';
  return { xml, numero, cune, totales: { devengados: 0, deducciones: 0, comprobante: 0 } };
}
