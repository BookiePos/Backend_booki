import { DOMParser } from '@xmldom/xmldom';
import { describe, expect, it } from 'vitest';
import { splitTaxIncluded } from '../../../sales/domain/sale-amounts';
import { firmarXml, verificarFirma } from '../../infrastructure/firma/firma-xades';
import { calcularCude, calcularCudePos, calcularCufe, type DatosCodigoUnico } from '../cufe';
import type { VentaParaDocumento } from '../documento-venta';
import { p12DePrueba } from '../p12-de-prueba.test';
import { CLAVE, CLIENTE_NIT, documento, EMISOR_FISCAL, linea, PIN, SOFTWARE_ID } from './__fixtures__/factura-de-prueba.test';
import { codigoSeguridadNota, documentoNota } from './__fixtures__/nota-de-prueba.test';
import { documentoPos } from './__fixtures__/pos-de-prueba.test';
import { validarXsdDian } from './__fixtures__/validar-xsd.test';
import { prepararFacturaUbl } from './factura-de-documento';
import { armarFacturaUbl, codigoSeguridadSoftware } from './factura-ubl';
import { prepararNotaUbl } from './nota-de-documento';
import { armarNotaCreditoUbl, armarNotaDebitoUbl } from './nota-ubl';
import { prepararPosUbl } from './pos-de-documento';
import { armarPosUbl } from './pos-ubl';

/**
 * Fase 11 · CUFE/CUDE por barrido. Los specs de cada builder recalculan el
 * código único desde el XML en un puñado de variantes fijas; aquí se hace con
 * cientos de ventas al azar (deterministas) por tipo de documento: IVA a varias
 * tarifas, INC, exentos, excluidos, bolsas, domicilio y propina mezclados.
 *
 * La DIAN recalcula el código con lo que LEE del XML. Si un total del XML no es
 * el que entró al hash, rechaza (FAD06) una venta que ya se cobró. Además se
 * comprueba, en enteros exactos, que los totales del XML son la suma de sus
 * líneas y que lo que se paga es lo que la venta cobró.
 *
 * Sin firma ni XSD (los cubren los specs de cada builder): aquí importa el dinero.
 */

function azar(semilla: number): () => number {
  let s = semilla >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

const TARIFAS = [
  { kind: 'iva', rate: 19 },
  { kind: 'iva', rate: 5 },
  { kind: 'iva', rate: 0, treatment: 'exento' },
  { kind: 'iva', rate: 0, treatment: 'excluido' },
  { kind: 'inc', rate: 8 },
] as const;

/** Una venta como la guarda el POS: precios con el impuesto incluido, en pesos enteros. */
function ventaAlAzar(r: () => number, o: { extras: boolean }): { venta: VentaParaDocumento; cobrado: number } {
  const n = 1 + Math.floor(r() * 6);
  let total = 0;
  const lines = Array.from({ length: n }, (_, i) => {
    const t = TARIFAS[Math.floor(r() * TARIFAS.length)]!;
    const qty = 1 + Math.floor(r() * 4);
    // Precios «feos» a propósito: no múltiplos de 50, para que el desglose deje residuos.
    const precio = qty * (1 + Math.floor(r() * 180_000));
    const impuesto = splitTaxIncluded(precio, t.rate).tax;
    const bolsa = o.extras && r() < 0.15 ? qty * 73 : undefined;
    total += precio + (bolsa ?? 0);
    return linea({
      name: `Producto ${i + 1}`,
      precio,
      impuesto,
      kind: t.kind,
      rate: t.rate,
      qty,
      treatment: 'treatment' in t ? t.treatment : undefined,
      bolsa,
    });
  });
  const venta: VentaParaDocumento = { lines, total };
  let cobrado = total;
  if (o.extras && r() < 0.4) {
    venta.tip = 1 + Math.floor(r() * 30_000);
    cobrado += venta.tip;
  }
  if (o.extras && r() < 0.4) {
    const fee = 1 + Math.floor(r() * 15_000);
    const conIva = r() < 0.5;
    const s = splitTaxIncluded(fee, conIva ? 19 : 8);
    Object.assign(venta, {
      deliveryFee: fee,
      deliveryTaxKind: conIva ? 'iva' : 'inc',
      deliveryTaxRate: conIva ? 19 : 8,
      deliveryTaxBase: s.base,
      deliveryTax: s.tax,
    });
    cobrado += fee;
  }
  return { venta, cobrado };
}

// ── Lo que la DIAN lee del XML, en centavos exactos (del texto, sin pasar por flotantes) ──
const NS_CBC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';
const NS_CAC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2';

function hijos(el: Element | undefined, ns: string, nombre: string): Element[] {
  const out: Element[] = [];
  for (let n = el?.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (n as Element).namespaceURI === ns && (n as Element).localName === nombre) out.push(n as Element);
  }
  return out;
}
const hijo = (el: Element | undefined, ns: string, nombre: string): Element | undefined => hijos(el, ns, nombre)[0];
const texto = (el: Element | undefined, nombre: string): string => hijo(el, NS_CBC, nombre)?.textContent ?? '';
function centavos(s: string): number {
  if (!/^\d+\.\d{2}$/.test(s)) throw new Error(`Monto del XML mal escrito: «${s}»`);
  return Number(s.replace('.', ''));
}

interface Leido {
  uuid: string;
  datos: DatosCodigoUnico;
  sumaLineas: number;
  sumaImpuestosLineas: Record<'01' | '04', number>;
  taxInclusive: number;
  cargos: number;
  payable: number;
}

function leer(xml: string): Leido {
  const raiz = (new DOMParser().parseFromString(xml, 'text/xml') as unknown as Document).documentElement;
  const tributoDe = (taxTotal: Element): string =>
    texto(hijo(hijo(hijo(taxTotal, NS_CAC, 'TaxSubtotal'), NS_CAC, 'TaxCategory'), NS_CAC, 'TaxScheme'), 'ID');
  const impuestos = { '01': 0, '04': 0, '03': 0 };
  for (const t of hijos(raiz, NS_CAC, 'TaxTotal')) {
    const codigo = tributoDe(t);
    if (codigo in impuestos) impuestos[codigo as keyof typeof impuestos] += centavos(texto(t, 'TaxAmount'));
  }
  const total = hijo(raiz, NS_CAC, 'LegalMonetaryTotal') ?? hijo(raiz, NS_CAC, 'RequestedMonetaryTotal');
  const nitDe = (rol: string): string =>
    texto(hijo(hijo(hijo(raiz, NS_CAC, rol), NS_CAC, 'Party'), NS_CAC, 'PartyTaxScheme'), 'CompanyID');
  const lineas = ['InvoiceLine', 'CreditNoteLine', 'DebitNoteLine'].flatMap((n) => hijos(raiz, NS_CAC, n));
  const sumaImpuestosLineas = { '01': 0, '04': 0 };
  for (const l of lineas) {
    for (const t of hijos(l, NS_CAC, 'TaxTotal')) {
      const codigo = tributoDe(t);
      if (codigo === '01' || codigo === '04') sumaImpuestosLineas[codigo] += centavos(texto(t, 'TaxAmount'));
    }
  }
  const cargo = texto(total, 'ChargeTotalAmount');
  return {
    uuid: texto(raiz, 'UUID'),
    datos: {
      numero: texto(raiz, 'ID'),
      fecha: texto(raiz, 'IssueDate'),
      hora: texto(raiz, 'IssueTime'),
      valorBruto: centavos(texto(total, 'LineExtensionAmount')),
      impuestos,
      valorTotal: centavos(texto(total, 'PayableAmount')),
      nitEmisor: nitDe('AccountingSupplierParty'),
      numAdquiriente: nitDe('AccountingCustomerParty'),
      tipoAmbiente: texto(raiz, 'ProfileExecutionID') as '1' | '2',
    },
    sumaLineas: lineas.reduce((a, l) => a + centavos(texto(l, 'LineExtensionAmount')), 0),
    sumaImpuestosLineas,
    taxInclusive: centavos(texto(total, 'TaxInclusiveAmount')),
    cargos: cargo ? centavos(cargo) : 0,
    payable: centavos(texto(total, 'PayableAmount')),
  };
}

/** Lo que tiene que cumplir cualquier documento, sea cual sea su tipo. */
function exigir(x: Leido, cufeGuardado: string | undefined, recalculado: string, cobrado: number, contexto: string): void {
  expect(x.uuid, contexto).toBe(cufeGuardado);
  expect(recalculado, contexto).toBe(cufeGuardado);
  expect(x.datos.valorBruto, `${contexto} · bruto = Σ líneas`).toBe(x.sumaLineas);
  expect(x.datos.impuestos['01'], `${contexto} · IVA = Σ líneas`).toBe(x.sumaImpuestosLineas['01']);
  expect(x.datos.impuestos['04'], `${contexto} · INC = Σ líneas`).toBe(x.sumaImpuestosLineas['04']);
  expect(x.datos.impuestos['03'], contexto).toBe(0);
  expect(x.payable, `${contexto} · a pagar = con impuestos + cargos`).toBe(x.taxInclusive + x.cargos);
  expect(x.payable, `${contexto} · a pagar = lo que cobró la venta`).toBe(cobrado * 100);
}

const N = 250;

describe('código único recalculado desde el XML · barrido de ventas al azar', () => {
  it(`factura (CUFE con clave técnica): ${N} ventas, con y sin NIT, en los dos ambientes`, () => {
    const r = azar(20261116);
    for (let i = 0; i < N; i += 1) {
      const { venta, cobrado } = ventaAlAzar(r, { extras: true });
      const doc = documento(venta, {
        cliente: i % 2 ? CLIENTE_NIT : undefined,
        ambiente: i % 3 ? '2' : '1',
        numero: 990000001 + i,
      });
      const f = prepararFacturaUbl(doc, EMISOR_FISCAL);
      const xml = armarFacturaUbl({ ...f, codigoSeguridadSoftware: codigoSeguridadSoftware(SOFTWARE_ID, PIN, doc.fullNumber) });
      const x = leer(xml);
      exigir(x, doc.cufe, calcularCufe({ ...x.datos, claveTecnica: CLAVE }), cobrado, `factura ${i}: ${JSON.stringify(venta)}`);
      // La clave técnica es la llave de la factura: con el PIN saldría otro código.
      expect(calcularCude({ ...x.datos, softwarePin: PIN })).not.toBe(doc.cufe);
    }
  });

  it(`POS (CUDE con el PIN): ${N} ventas, anónimas e identificadas`, () => {
    const r = azar(7_2026);
    for (let i = 0; i < N; i += 1) {
      const { venta, cobrado } = ventaAlAzar(r, { extras: true });
      const doc = documentoPos(venta, { cliente: i % 2 ? CLIENTE_NIT : undefined, ambiente: i % 3 ? '2' : '1', numero: 1 + i });
      const p = prepararPosUbl(doc, EMISOR_FISCAL);
      const xml = armarPosUbl({ ...p, codigoSeguridadSoftware: codigoSeguridadSoftware(SOFTWARE_ID, PIN, doc.fullNumber) });
      const x = leer(xml);
      exigir(x, doc.cufe, calcularCudePos({ ...x.datos, softwarePin: PIN }), cobrado, `POS ${i}: ${JSON.stringify(venta)}`);
      expect(calcularCufe({ ...x.datos, claveTecnica: CLAVE })).not.toBe(doc.cufe);
    }
  });

  it.each([
    ['nota crédito', 'credit_note', '1'],
    ['nota débito', 'debit_note', '3'],
  ] as const)(`%s (CUDE con el PIN): ${N} notas`, (_nombre, tipo, concepto) => {
    const r = azar(tipo === 'credit_note' ? 91 : 92);
    for (let i = 0; i < N; i += 1) {
      // La nota acredita o carga líneas de producto; sin propina, domicilio ni bolsa.
      const { venta, cobrado } = ventaAlAzar(r, { extras: false });
      const doc = documentoNota(venta, { tipo, concepto, cliente: i % 2 ? CLIENTE_NIT : undefined, numero: 1 + i });
      const n = prepararNotaUbl(doc, EMISOR_FISCAL);
      const completa = { ...n, codigoSeguridadSoftware: codigoSeguridadNota(doc.fullNumber) };
      const xml = tipo === 'credit_note' ? armarNotaCreditoUbl(completa) : armarNotaDebitoUbl(completa);
      const x = leer(xml);
      exigir(x, doc.cufe, calcularCude({ ...x.datos, softwarePin: PIN }), cobrado, `${tipo} ${i}: ${JSON.stringify(venta)}`);
      // La nota nunca se calcula con la clave técnica de la resolución.
      expect(calcularCufe({ ...x.datos, claveTecnica: CLAVE })).not.toBe(doc.cufe);
    }
  });
});

describe('builders contra el XSD oficial · ventas al azar con todo mezclado, firmadas', () => {
  const CERT = { p12: p12DePrueba(), password: 'clave-de-prueba' };
  const firmadoYValido = async (xml: string, nombre: string): Promise<void> => {
    const firmado = firmarXml(xml, CERT);
    expect(verificarFirma(firmado)).toEqual({ valida: true });
    const r = await validarXsdDian(firmado, nombre);
    expect(r.errores, nombre).toEqual([]);
  };
  const seguridad = (numero: string): string => codigoSeguridadSoftware(SOFTWARE_ID, PIN, numero);

  // Las variantes fijas de cada builder prueban un rasgo por documento; aquí van juntos
  // (varias tarifas + exento + excluido + bolsa + domicilio + propina en la misma venta).
  it.each([0, 1, 2])('factura, POS, nota crédito y nota débito de la venta al azar n.º %i', async (i) => {
    const r = azar(5000 + i);
    const { venta } = ventaAlAzar(r, { extras: true });
    const cliente = i % 2 ? CLIENTE_NIT : undefined;

    const factura = documento(venta, { cliente });
    await firmadoYValido(
      armarFacturaUbl({ ...prepararFacturaUbl(factura, EMISOR_FISCAL), codigoSeguridadSoftware: seguridad(factura.fullNumber) }),
      `barrido-factura-${i}.xml`,
    );

    const pos = documentoPos(venta, { cliente });
    await firmadoYValido(
      armarPosUbl({ ...prepararPosUbl(pos, EMISOR_FISCAL), codigoSeguridadSoftware: seguridad(pos.fullNumber) }),
      `barrido-pos-${i}.xml`,
    );

    const { venta: parcial } = ventaAlAzar(r, { extras: false });
    const nc = documentoNota(parcial, { tipo: 'credit_note', concepto: '1', cliente });
    await firmadoYValido(
      armarNotaCreditoUbl({ ...prepararNotaUbl(nc, EMISOR_FISCAL), codigoSeguridadSoftware: codigoSeguridadNota(nc.fullNumber) }),
      `barrido-nc-${i}.xml`,
    );
    const nd = documentoNota(parcial, { tipo: 'debit_note', concepto: '3', cliente });
    await firmadoYValido(
      armarNotaDebitoUbl({ ...prepararNotaUbl(nd, EMISOR_FISCAL), codigoSeguridadSoftware: codigoSeguridadNota(nd.fullNumber) }),
      `barrido-nd-${i}.xml`,
    );
  }, 120_000);
});
