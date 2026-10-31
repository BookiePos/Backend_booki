import { createHash } from 'crypto';
import { cop } from '../../../finance/domain/money.util';
import { assertFechaHoraDian, dianVerificationUrl } from '../cufe';
import type { CargoDocumento, LineaDocumento, TotalesDocumento } from '../documento-venta';
import { primerTributo } from '../documento-venta';
import type { TipoAmbiente } from '../emisor-fiscal';
import { descuadres, formatearMontoDian, redondearLinea, type Centavos } from '../redondeo';
import {
  AGENCIA_DIAN,
  cantidad,
  centavos,
  codigoUnidad,
  DEPARTAMENTOS_DANE,
  DocumentoUblInvalidoError,
  esc,
  LISTA_PAISES,
  monto,
  municipioDaneValido,
  porcentaje,
} from './xml-ubl';

/**
 * Builder UBL 2.1 de la factura electrónica de venta (`Invoice`, anexo técnico
 * FEV 1.9, Res. DIAN 000165 de 2023). Función pura: recibe el documento ya
 * calculado (Fase 2: líneas con su tributo, cargos y totales) y devuelve el XML
 * SIN firmar, con la segunda `ext:UBLExtension` vacía para la XAdES de
 * `firmarXml`.
 *
 * - Los montos son los del documento (COP entero) pasados a centavos y
 *   formateados por `formatearMontoDian`: nada se recalcula a 2 decimales.
 * - Los totales del XML son la SUMA de las líneas; si los guardados en el
 *   documento no coinciden (tolerancia 0), se lanza antes de armar nada.
 * - El PIN del software no entra aquí: llega solo su hash
 *   (`codigoSeguridadSoftware`), que es lo que viaja en el XML.
 *
 * El XSD oficial lo comprueba `factura-ubl.spec.ts`; las reglas de negocio del
 * anexo (Schematron) solo las confirma el set de pruebas de habilitación.
 */

/**
 * Namespace de `sts:` tal como lo declara el XSD oficial
 * (`DIAN_UBL_Structures.xsd`) y el ejemplo `Generica.xml` de la DIAN.
 */
export const NS_STS = 'dian:gov:co:facturaelectronica:Structures-2-1';
/** NIT de la DIAN (AuthorizationProvider) y su DV. */
export const NIT_DIAN = '800197268';
export const DV_NIT_DIAN = '4';

const PERFIL_FACTURA = 'DIAN 2.1: Factura Electrónica de Venta';
/** 10 = factura estándar (tabla de tipos de operación). */
const TIPO_OPERACION = '10';
/** 01 = factura electrónica de venta. */
const TIPO_FACTURA = '01';

const NOMBRE_TRIBUTO: Record<string, string> = {
  '01': 'IVA',
  '04': 'INC',
  '22': 'INC Bolsas',
  ZA: 'IVA e INC',
  ZZ: 'No aplica',
};

/** Tributo de una parte en `PartyTaxScheme` (tabla de tributos del anexo). */
export type TributoParte = '01' | '04' | 'ZA' | 'ZZ';

export interface DireccionUbl {
  /** Código DANE del municipio (5 dígitos). */
  municipioDane: string;
  /** Nombre del municipio, si se conoce. */
  ciudad?: string;
  linea: string;
}

/** Emisor o adquiriente, ya validado por `prepararFacturaUbl`. */
export interface ParteUbl {
  /** 1 jurídica, 2 natural. */
  tipoPersona: '1' | '2';
  /** Código DIAN del tipo de documento (13 CC, 31 NIT…). */
  tipoDocumento: string;
  /** Número sin puntos, guion ni DV. */
  numero: string;
  /** Solo con NIT. */
  dv?: string;
  nombre: string;
  /** Responsabilidades del RUT (TaxLevelCode). */
  responsabilidades: string[];
  /** `listName` del TaxLevelCode: 48 responsable de IVA, 49 no responsable. */
  listaResponsabilidades: '48' | '49';
  tributo: TributoParte;
  direccion?: DireccionUbl;
  email?: string;
  telefono?: string;
}

export interface ResolucionUbl {
  numero: string;
  /** YYYY-MM-DD */
  desde: string;
  hasta: string;
  prefijo?: string;
  rangoDesde: number;
  rangoHasta: number;
}

export interface FacturaUbl {
  /** Prefijo + número (cbc:ID). */
  numero: string;
  prefijo?: string;
  cufe: string;
  /** YYYY-MM-DD y HH:MM:SS-05:00: los MISMOS del CUFE. */
  fecha: string;
  hora: string;
  tipoAmbiente: TipoAmbiente;
  resolucion: ResolucionUbl;
  softwareId: string;
  /** SHA-384(SoftwareID + PIN + número): ver `codigoSeguridadSoftware`. */
  codigoSeguridadSoftware: string;
  emisor: ParteUbl;
  adquiriente: ParteUbl;
  /** 1 contado, 2 crédito. */
  formaPago: '1' | '2';
  /** Medio de pago (tabla del anexo; 10 efectivo). */
  medioPago: string;
  /** Vencimiento (YYYY-MM-DD) de una venta a crédito. */
  vencimiento?: string;
  lineas: LineaDocumento[];
  cargos: CargoDocumento[];
  totales: TotalesDocumento;
}

const SHA384_HEX = /^[0-9a-f]{96}$/;

function sha384(s: string): string {
  return createHash('sha384').update(s, 'utf8').digest('hex');
}

/**
 * `sts:SoftwareSecurityCode` (anexo FEV 1.9 §11.1.3): SHA-384 de SoftwareID +
 * PIN + número del documento. Los errores no citan ninguno de los valores.
 */
export function codigoSeguridadSoftware(softwareId: string, pin: string, numero: string): string {
  if (!softwareId?.trim()) throw new DocumentoUblInvalidoError('Falta el SoftwareID del emisor');
  if (!pin?.trim()) throw new DocumentoUblInvalidoError('Falta el PIN del software del emisor');
  if (!numero?.trim()) throw new DocumentoUblInvalidoError('Falta el número del documento');
  return sha384(`${softwareId}${pin}${numero}`);
}

// ── Totales ────────────────────────────────────────────────────────────────

/** Totales del XML, en centavos, calculados SOLO desde las líneas y los cargos. */
export interface TotalesUbl {
  lineExtension: Centavos;
  taxExclusive: Centavos;
  iva: Centavos;
  inc: Centavos;
  bolsas: Centavos;
  taxInclusive: Centavos;
  cargos: Centavos;
  payable: Centavos;
}

export function totalesUbl(lineas: readonly LineaDocumento[], cargos: readonly CargoDocumento[]): TotalesUbl {
  let lineExtension = 0;
  let taxExclusive = 0;
  let iva = 0;
  let inc = 0;
  let bolsas = 0;
  lineas.forEach((l, i) => {
    const que = `Línea ${i + 1}`;
    const base = centavos(l.base, `${que}, base`);
    lineExtension += base;
    const primero = primerTributo(l);
    if (primero) taxExclusive += centavos(primero.taxableAmount, `${que}, base gravable`);
    const impuesto = centavos(l.taxScheme ? l.taxAmount : 0, `${que}, impuesto`);
    if (l.taxScheme === '01') iva += impuesto;
    if (l.taxScheme === '04') inc += impuesto;
    if (l.perUnitTax) bolsas += centavos(l.perUnitTax.valor, `${que}, INC de bolsas`);
  });
  let totalCargos = 0;
  cargos.forEach((c, i) => {
    if (!c.chargeIndicator) {
      throw new DocumentoUblInvalidoError(`Cargo ${i + 1}: los descuentos de documento no están soportados`);
    }
    totalCargos += centavos(c.amount, `Cargo ${i + 1}`);
  });
  const taxInclusive = lineExtension + iva + inc + bolsas;
  return {
    lineExtension,
    taxExclusive,
    iva,
    inc,
    bolsas,
    taxInclusive,
    cargos: totalCargos,
    payable: taxInclusive + totalCargos,
  };
}

/**
 * Descuadres del documento (tolerancia 0): cada línea consigo misma, los
 * totales guardados contra la suma de las líneas y, con `descuadres` de
 * `redondeo.ts`, lo que entra al CUFE.
 */
export function descuadresFactura(f: Pick<FacturaUbl, 'lineas' | 'cargos' | 'totales'>): string[] {
  const fallas: string[] = [];
  f.lineas.forEach((l, i) => {
    const que = `línea ${i + 1}`;
    if (!l.taxScheme && l.taxAmount) fallas.push(`${que}: impuesto sin tributo`);
    const bolsa = l.perUnitTax;
    if (bolsa) {
      if (bolsa.codigo !== '22') fallas.push(`${que}: tributo por unidad desconocido`);
      if (bolsa.unidades * bolsa.valorUnitario !== bolsa.valor) {
        fallas.push(`${que}: INC de bolsas ${bolsa.valor} ≠ ${bolsa.unidades} × ${bolsa.valorUnitario}`);
      }
    }
    const suma = l.base + (l.taxScheme ? l.taxAmount : 0) + (bolsa?.valor ?? 0);
    if (l.total !== suma) fallas.push(`${que}: total ${l.total} ≠ base + impuestos ${suma}`);
  });

  const t = totalesUbl(f.lineas, f.cargos);
  const pesos = (c: Centavos) => c / 100;
  const comparar = (que: string, guardado: number | undefined, calculado: Centavos) => {
    if (guardado !== pesos(calculado)) fallas.push(`${que}: ${String(guardado)} ≠ suma de líneas ${pesos(calculado)}`);
  };
  const g = f.totales;
  comparar('LineExtensionAmount', g.taxableBase, t.lineExtension);
  comparar('TaxExclusiveAmount', g.taxExclusiveAmount, t.taxExclusive);
  comparar('IVA', g.ivaTotal, t.iva);
  comparar('INC', g.incTotal, t.inc);
  comparar('INC de bolsas', g.bagTaxTotal, t.bolsas);
  comparar('TaxInclusiveAmount', g.taxInclusiveAmount, t.taxInclusive);
  comparar('ChargeTotalAmount', g.chargeTotal, t.cargos);
  comparar('PayableAmount', g.payableAmount, t.payable);
  if (g.icaTotal) fallas.push('ICA: BookiPos no emite el tributo 03');

  // Lo que la DIAN recalcula para verificar el CUFE, con la política única de redondeo.
  const lineasDian = f.lineas.map((l) =>
    redondearLinea({ base: l.base, impuestos: l.taxScheme ? { [l.taxScheme]: l.taxAmount } : {} }),
  );
  fallas.push(
    ...descuadres(lineasDian, {
      valorBruto: t.lineExtension,
      impuestos: { '01': t.iva, '04': t.inc, '03': 0 },
      valorTotal: t.lineExtension + t.iva + t.inc,
    }),
  );
  return fallas;
}

// ── Validación de entrada ─────────────────────────────────────────────────────

function validar(f: FacturaUbl): void {
  const fallas: string[] = [];
  if (!f.numero?.trim()) fallas.push('número');
  if (!SHA384_HEX.test(f.cufe ?? '')) fallas.push('CUFE (SHA-384 en hexadecimal)');
  if (f.tipoAmbiente !== '1' && f.tipoAmbiente !== '2') fallas.push('tipo de ambiente');
  if (!SHA384_HEX.test(f.codigoSeguridadSoftware ?? '')) fallas.push('código de seguridad del software');
  if (!f.softwareId?.trim()) fallas.push('SoftwareID');
  if (f.formaPago !== '1' && f.formaPago !== '2') fallas.push('forma de pago');
  if (!/^[0-9A-Z]{1,3}$/.test(f.medioPago ?? '')) fallas.push('medio de pago');
  if (f.lineas.length === 0) fallas.push('líneas');
  if (fallas.length > 0) {
    throw new DocumentoUblInvalidoError(`La factura no se puede armar; revisa: ${fallas.join(', ')}`);
  }
  try {
    assertFechaHoraDian(f.fecha, f.hora);
  } catch (err) {
    throw new DocumentoUblInvalidoError((err as Error).message);
  }
  const descuadre = descuadresFactura(f);
  if (descuadre.length > 0) {
    throw new DocumentoUblInvalidoError(`El documento no cuadra: ${descuadre.join('; ')}`);
  }
}

// ── Piezas del XML ───────────────────────────────────────────────────────────

function dianExtensions(f: FacturaUbl): string {
  const r = f.resolucion;
  const prefijo = r.prefijo ? `\n              <sts:Prefix>${esc(r.prefijo)}</sts:Prefix>` : '';
  return `<sts:DianExtensions>
          <sts:InvoiceControl>
            <sts:InvoiceAuthorization>${esc(r.numero)}</sts:InvoiceAuthorization>
            <sts:AuthorizationPeriod>
              <cbc:StartDate>${esc(r.desde)}</cbc:StartDate>
              <cbc:EndDate>${esc(r.hasta)}</cbc:EndDate>
            </sts:AuthorizationPeriod>
            <sts:AuthorizedInvoices>${prefijo}
              <sts:From>${r.rangoDesde}</sts:From>
              <sts:To>${r.rangoHasta}</sts:To>
            </sts:AuthorizedInvoices>
          </sts:InvoiceControl>
          <sts:InvoiceSource>
            <cbc:IdentificationCode ${LISTA_PAISES}>CO</cbc:IdentificationCode>
          </sts:InvoiceSource>
          <sts:SoftwareProvider>
            <sts:ProviderID ${AGENCIA_DIAN} schemeID="${f.emisor.dv ?? ''}" schemeName="31">${esc(f.emisor.numero)}</sts:ProviderID>
            <sts:SoftwareID ${AGENCIA_DIAN}>${esc(f.softwareId)}</sts:SoftwareID>
          </sts:SoftwareProvider>
          <sts:SoftwareSecurityCode ${AGENCIA_DIAN}>${f.codigoSeguridadSoftware}</sts:SoftwareSecurityCode>
          <sts:AuthorizationProvider>
            <sts:AuthorizationProviderID ${AGENCIA_DIAN} schemeID="${DV_NIT_DIAN}" schemeName="31">${NIT_DIAN}</sts:AuthorizationProviderID>
          </sts:AuthorizationProvider>
          <sts:QRCode>${esc(dianVerificationUrl(f.cufe, f.tipoAmbiente))}</sts:QRCode>
        </sts:DianExtensions>`;
}

function identificacion(p: ParteUbl, tag: 'CompanyID' | 'ID'): string {
  const dv = p.tipoDocumento === '31' && p.dv ? ` schemeID="${p.dv}"` : '';
  return `<cbc:${tag} ${AGENCIA_DIAN}${dv} schemeName="${p.tipoDocumento}">${esc(p.numero)}</cbc:${tag}>`;
}

function direccion(d: DireccionUbl, tag: 'Address' | 'RegistrationAddress', sangria: string): string {
  const depto = d.municipioDane.slice(0, 2);
  return [
    `<cac:${tag}>`,
    `  <cbc:ID>${d.municipioDane}</cbc:ID>`,
    d.ciudad ? `  <cbc:CityName>${esc(d.ciudad)}</cbc:CityName>` : '',
    `  <cbc:CountrySubentity>${esc(DEPARTAMENTOS_DANE[depto] ?? '')}</cbc:CountrySubentity>`,
    `  <cbc:CountrySubentityCode>${depto}</cbc:CountrySubentityCode>`,
    `  <cac:AddressLine>`,
    `    <cbc:Line>${esc(d.linea)}</cbc:Line>`,
    `  </cac:AddressLine>`,
    `  <cac:Country>`,
    `    <cbc:IdentificationCode ${LISTA_PAISES}>CO</cbc:IdentificationCode>`,
    `    <cbc:Name languageID="es">Colombia</cbc:Name>`,
    `  </cac:Country>`,
    `</cac:${tag}>`,
  ]
    .filter(Boolean)
    .join(`\n${sangria}`);
}

function parte(
  rol: 'AccountingSupplierParty' | 'AccountingCustomerParty',
  p: ParteUbl,
  prefijo?: string,
): string {
  // FAK: el adquiriente persona natural lleva además su documento en PartyIdentification.
  const partyId =
    rol === 'AccountingCustomerParty' && p.tipoPersona === '2'
      ? `
      <cac:PartyIdentification>
        ${identificacion(p, 'ID')}
      </cac:PartyIdentification>`
      : '';
  const fisica = p.direccion
    ? `
      <cac:PhysicalLocation>
        ${direccion(p.direccion, 'Address', '        ')}
      </cac:PhysicalLocation>`
    : '';
  const registro = p.direccion
    ? `
        ${direccion(p.direccion, 'RegistrationAddress', '        ')}`
    : '';
  const registroMercantil = prefijo
    ? `
        <cac:CorporateRegistrationScheme>
          <cbc:ID>${esc(prefijo)}</cbc:ID>
        </cac:CorporateRegistrationScheme>`
    : '';
  const contactos = [
    p.telefono ? `<cbc:Telephone>${esc(p.telefono)}</cbc:Telephone>` : '',
    p.email ? `<cbc:ElectronicMail>${esc(p.email)}</cbc:ElectronicMail>` : '',
  ].filter(Boolean);
  const contacto = contactos.length
    ? `
      <cac:Contact>
        ${contactos.join('\n        ')}
      </cac:Contact>`
    : '';
  const responsabilidades = (p.responsabilidades.length ? p.responsabilidades : ['R-99-PN']).join(';');
  return `<cac:${rol}>
    <cbc:AdditionalAccountID>${p.tipoPersona}</cbc:AdditionalAccountID>
    <cac:Party>${partyId}
      <cac:PartyName>
        <cbc:Name>${esc(p.nombre)}</cbc:Name>
      </cac:PartyName>${fisica}
      <cac:PartyTaxScheme>
        <cbc:RegistrationName>${esc(p.nombre)}</cbc:RegistrationName>
        ${identificacion(p, 'CompanyID')}
        <cbc:TaxLevelCode listName="${p.listaResponsabilidades}">${esc(responsabilidades)}</cbc:TaxLevelCode>${registro}
        <cac:TaxScheme>
          <cbc:ID>${p.tributo}</cbc:ID>
          <cbc:Name>${NOMBRE_TRIBUTO[p.tributo]}</cbc:Name>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${esc(p.nombre)}</cbc:RegistrationName>
        ${identificacion(p, 'CompanyID')}${registroMercantil}
      </cac:PartyLegalEntity>${contacto}
    </cac:Party>
  </cac:${rol}>`;
}

function medioDePago(f: FacturaUbl): string {
  const vence =
    f.formaPago === '2'
      ? `
    <cbc:PaymentDueDate>${esc(f.vencimiento ?? f.fecha)}</cbc:PaymentDueDate>`
      : '';
  return `<cac:PaymentMeans>
    <cbc:ID>${f.formaPago}</cbc:ID>
    <cbc:PaymentMeansCode>${f.medioPago}</cbc:PaymentMeansCode>${vence}
  </cac:PaymentMeans>`;
}

/** Cargos de documento (la propina): no gravados, suman al PayableAmount. */
function cargosXml(cargos: readonly CargoDocumento[], base: Centavos): string {
  return cargos
    .map((c, i) => {
      const valor = centavos(c.amount, `Cargo ${i + 1}`);
      // Porcentaje del cargo sobre la base, en centésimas: cop() cierra la división.
      const factor =
        base > 0
          ? `
    <cbc:MultiplierFactorNumeric>${formatearMontoDian(cop((valor * 10_000) / base))}</cbc:MultiplierFactorNumeric>`
          : '';
      return `
  <cac:AllowanceCharge>
    <cbc:ID>${i + 1}</cbc:ID>
    <cbc:ChargeIndicator>true</cbc:ChargeIndicator>
    <cbc:AllowanceChargeReason>${esc(c.reason)}</cbc:AllowanceChargeReason>${factor}
    <cbc:Amount ${monto(valor)}</cbc:Amount>
    <cbc:BaseAmount ${monto(base)}</cbc:BaseAmount>
  </cac:AllowanceCharge>`;
    })
    .join('');
}

function subtotalAdValorem(codigo: '01' | '04', base: Centavos, impuesto: Centavos, tarifa: number, s: string): string {
  return `<cac:TaxSubtotal>
${s}  <cbc:TaxableAmount ${monto(base)}</cbc:TaxableAmount>
${s}  <cbc:TaxAmount ${monto(impuesto)}</cbc:TaxAmount>
${s}  <cac:TaxCategory>
${s}    <cbc:Percent>${porcentaje(tarifa)}</cbc:Percent>
${s}    <cac:TaxScheme>
${s}      <cbc:ID>${codigo}</cbc:ID>
${s}      <cbc:Name>${NOMBRE_TRIBUTO[codigo]}</cbc:Name>
${s}    </cac:TaxScheme>
${s}  </cac:TaxCategory>
${s}</cac:TaxSubtotal>`;
}

/**
 * Tributo nominal (22, INC de bolsas): sin Percent; unidades en
 * BaseUnitMeasure y valor por unidad en PerUnitAmount. TaxableAmount 0.00:
 * no hay base ad valorem (ver «Confirmar en habilitación»).
 */
function subtotalBolsa(unidades: number, porUnidad: Centavos, impuesto: Centavos, s: string): string {
  return `<cac:TaxSubtotal>
${s}  <cbc:TaxableAmount ${monto(0)}</cbc:TaxableAmount>
${s}  <cbc:TaxAmount ${monto(impuesto)}</cbc:TaxAmount>
${s}  <cbc:BaseUnitMeasure unitCode="94">${cantidad(unidades)}</cbc:BaseUnitMeasure>
${s}  <cbc:PerUnitAmount ${monto(porUnidad)}</cbc:PerUnitAmount>
${s}  <cac:TaxCategory>
${s}    <cac:TaxScheme>
${s}      <cbc:ID>22</cbc:ID>
${s}      <cbc:Name>${NOMBRE_TRIBUTO['22']}</cbc:Name>
${s}    </cac:TaxScheme>
${s}  </cac:TaxCategory>
${s}</cac:TaxSubtotal>`;
}

function taxTotal(total: Centavos, subtotales: string[], s: string): string {
  return `<cac:TaxTotal>
${s}  <cbc:TaxAmount ${monto(total)}</cbc:TaxAmount>
${s}  ${subtotales.join(`\n${s}  `)}
${s}</cac:TaxTotal>`;
}

/** TaxTotal de la cabecera: uno por tributo (01, 04, 22), con un TaxSubtotal por tarifa. */
function taxTotalesCabecera(lineas: readonly LineaDocumento[]): string {
  const bloques: string[] = [];
  for (const codigo of ['01', '04'] as const) {
    const porTarifa = new Map<number, { base: Centavos; impuesto: Centavos }>();
    for (const l of lineas) {
      if (l.taxScheme !== codigo) continue;
      const acc = porTarifa.get(l.taxRate) ?? { base: 0, impuesto: 0 };
      porTarifa.set(l.taxRate, {
        base: acc.base + centavos(l.base, 'Base'),
        impuesto: acc.impuesto + centavos(l.taxAmount, 'Impuesto'),
      });
    }
    if (porTarifa.size === 0) continue;
    const grupos = [...porTarifa.entries()].sort(([a], [b]) => b - a);
    const total = grupos.reduce((s, [, g]) => s + g.impuesto, 0);
    bloques.push(
      taxTotal(
        total,
        grupos.map(([tarifa, g]) => subtotalAdValorem(codigo, g.base, g.impuesto, tarifa, '    ')),
        '  ',
      ),
    );
  }
  const bolsas = new Map<Centavos, { unidades: number; impuesto: Centavos }>();
  for (const l of lineas) {
    if (!l.perUnitTax) continue;
    const porUnidad = centavos(l.perUnitTax.valorUnitario, 'INC de bolsas por unidad');
    const acc = bolsas.get(porUnidad) ?? { unidades: 0, impuesto: 0 };
    bolsas.set(porUnidad, {
      unidades: acc.unidades + l.perUnitTax.unidades,
      impuesto: acc.impuesto + centavos(l.perUnitTax.valor, 'INC de bolsas'),
    });
  }
  if (bolsas.size > 0) {
    const grupos = [...bolsas.entries()];
    const total = grupos.reduce((s, [, g]) => s + g.impuesto, 0);
    bloques.push(
      taxTotal(
        total,
        grupos.map(([porUnidad, g]) => subtotalBolsa(g.unidades, porUnidad, g.impuesto, '    ')),
        '  ',
      ),
    );
  }
  return bloques.map((b) => `\n  ${b}`).join('');
}

function legalMonetaryTotal(t: TotalesUbl, conCargos: boolean): string {
  const cargos = conCargos
    ? `
    <cbc:ChargeTotalAmount ${monto(t.cargos)}</cbc:ChargeTotalAmount>`
    : '';
  return `<cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount ${monto(t.lineExtension)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount ${monto(t.taxExclusive)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount ${monto(t.taxInclusive)}</cbc:TaxInclusiveAmount>${cargos}
    <cbc:PayableAmount ${monto(t.payable)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>`;
}

/**
 * Una `cac:InvoiceLine`. El precio va como PriceAmount = base de la línea
 * sobre BaseQuantity = cantidad («la cantidad real sobre la cual el precio
 * aplica»): así PriceAmount × cantidad / BaseQuantity es la base EXACTA, sin
 * dividir pesos entre unidades (la base ya viene neta de descuentos).
 */
function lineaXml(l: LineaDocumento, i: number): string {
  const unidad = codigoUnidad(l.unitCode);
  const qty = cantidad(l.qty);
  const base = centavos(l.base, `Línea ${i + 1}, base`);
  const impuestos: string[] = [];
  if (l.taxScheme) {
    const imp = centavos(l.taxAmount, `Línea ${i + 1}, impuesto`);
    impuestos.push(taxTotal(imp, [subtotalAdValorem(l.taxScheme, base, imp, l.taxRate, '        ')], '      '));
  }
  if (l.perUnitTax) {
    const b = l.perUnitTax;
    const imp = centavos(b.valor, `Línea ${i + 1}, INC de bolsas`);
    const porUnidad = centavos(b.valorUnitario, `Línea ${i + 1}, INC de bolsas por unidad`);
    impuestos.push(taxTotal(imp, [subtotalBolsa(b.unidades, porUnidad, imp, '        ')], '      '));
  }
  const tributos = impuestos.map((x) => `\n      ${x}`).join('');
  if (!l.description?.trim()) throw new DocumentoUblInvalidoError(`Línea ${i + 1}: sin descripción`);
  return `
  <cac:InvoiceLine>
    <cbc:ID>${i + 1}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="${unidad}">${qty}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount ${monto(base)}</cbc:LineExtensionAmount>
    <cbc:FreeOfChargeIndicator>false</cbc:FreeOfChargeIndicator>${tributos}
    <cac:Item>
      <cbc:Description>${esc(l.description)}</cbc:Description>
      <cac:StandardItemIdentification>
        <cbc:ID schemeID="999" schemeName="Estándar de adopción del contribuyente">${esc(l.code?.trim() || String(i + 1))}</cbc:ID>
      </cac:StandardItemIdentification>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount ${monto(base)}</cbc:PriceAmount>
      <cbc:BaseQuantity unitCode="${unidad}">${qty}</cbc:BaseQuantity>
    </cac:Price>
  </cac:InvoiceLine>`;
}

function validarParte(p: ParteUbl, que: string): void {
  if (!/^[0-9A-Za-z-]{1,20}$/.test(p.numero)) throw new DocumentoUblInvalidoError(`${que}: número de documento inválido`);
  if (!/^\d{2}$/.test(p.tipoDocumento)) throw new DocumentoUblInvalidoError(`${que}: tipo de documento inválido`);
  if (p.dv !== undefined && !/^\d$/.test(p.dv)) throw new DocumentoUblInvalidoError(`${que}: DV inválido`);
  if (p.direccion && !municipioDaneValido(p.direccion.municipioDane)) {
    throw new DocumentoUblInvalidoError(`${que}: municipio DANE inválido`);
  }
}

/** XML UBL 2.1 de la factura, SIN firmar. Lanza `DocumentoUblInvalidoError` si algo no cuadra. */
export function armarFacturaUbl(f: FacturaUbl): string {
  validar(f);
  validarParte(f.emisor, 'Emisor');
  validarParte(f.adquiriente, 'Adquiriente');
  if (f.emisor.tipoDocumento !== '31' || !f.emisor.dv) {
    throw new DocumentoUblInvalidoError('Emisor: el facturador se identifica con NIT y DV');
  }
  const t = totalesUbl(f.lineas, f.cargos);
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2" xmlns:sts="${NS_STS}">
  <ext:UBLExtensions>
    <ext:UBLExtension>
      <ext:ExtensionContent>
        ${dianExtensions(f)}
      </ext:ExtensionContent>
    </ext:UBLExtension>
    <ext:UBLExtension>
      <ext:ExtensionContent></ext:ExtensionContent>
    </ext:UBLExtension>
  </ext:UBLExtensions>
  <cbc:UBLVersionID>UBL 2.1</cbc:UBLVersionID>
  <cbc:CustomizationID>${TIPO_OPERACION}</cbc:CustomizationID>
  <cbc:ProfileID>${PERFIL_FACTURA}</cbc:ProfileID>
  <cbc:ProfileExecutionID>${f.tipoAmbiente}</cbc:ProfileExecutionID>
  <cbc:ID>${esc(f.numero)}</cbc:ID>
  <cbc:UUID schemeID="${f.tipoAmbiente}" schemeName="CUFE-SHA384">${f.cufe}</cbc:UUID>
  <cbc:IssueDate>${f.fecha}</cbc:IssueDate>
  <cbc:IssueTime>${f.hora}</cbc:IssueTime>
  <cbc:InvoiceTypeCode>${TIPO_FACTURA}</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>COP</cbc:DocumentCurrencyCode>
  <cbc:LineCountNumeric>${f.lineas.length}</cbc:LineCountNumeric>
  ${parte('AccountingSupplierParty', f.emisor, f.prefijo)}
  ${parte('AccountingCustomerParty', f.adquiriente)}
  ${medioDePago(f)}${cargosXml(f.cargos, t.lineExtension)}${taxTotalesCabecera(f.lineas)}
  ${legalMonetaryTotal(t, f.cargos.length > 0)}${f.lineas.map(lineaXml).join('')}
</Invoice>
`;
}
