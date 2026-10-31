import PDFDocument from 'pdfkit';
import type { ElectronicDocument } from '../schemas/electronic-document.schema';
import { dianVerificationUrl } from '../../domain/cufe';
import { TIPOS_AMBIENTE, type TipoAmbiente } from '../../domain/emisor-fiscal';
import { generarQrMatrix } from '../../domain/entrega/qr';

/**
 * Representación gráfica (PDF) de la factura electrónica de venta (Fase 5B).
 *
 * Función pura: datos del documento → bytes del PDF (pdfkit, la misma librería
 * del desprendible de nómina). Lleva emisor, adquiriente, líneas, tributos
 * (IVA, INC, INC de bolsas), propina, totales, CUFE, QR con la URL de consulta
 * de la DIAN, la resolución de numeración (número, fechas, rango y prefijo) y
 * la leyenda de representación gráfica. Todo sale del documento congelado al
 * emitir: nada se recalcula aquí.
 */

export const LEYENDA_REPRESENTACION =
  'Representación gráfica de la factura electrónica de venta. Documento validado por la DIAN: ' +
  'consúltelo con el CUFE o con el código QR en el catálogo de la DIAN.';

/** Lo que el PDF lee del documento electrónico (subconjunto del esquema). */
export type DocumentoParaPdf = Pick<
  ElectronicDocument,
  | 'type'
  | 'fullNumber'
  | 'issueDate'
  | 'issueTime'
  | 'lines'
  | 'taxableBase'
  | 'ivaTotal'
  | 'discountTotal'
  | 'total'
  | 'formaPago'
> &
  Partial<
    Pick<
      ElectronicDocument,
      | 'cufe'
      | 'qrUrl'
      | 'tipoAmbiente'
      | 'emisor'
      | 'adquiriente'
      | 'incTotal'
      | 'icaTotal'
      | 'bagTaxTotal'
      | 'charges'
      | 'chargeTotal'
      | 'payableAmount'
      | 'medioPago'
      | 'resolution'
      | 'respuestaDian'
    >
  >;

export interface LineaPdf {
  codigo: string;
  descripcion: string;
  cantidad: string;
  unitario: number;
  descuento: number;
  base: number;
  tributo: string;
  total: number;
}

export interface DatosRepresentacion {
  numero: string;
  fecha: string;
  hora: string;
  validadoAt?: string;
  habilitacion: boolean;
  emisor: { nombre: string; nit: string; lineas: string[] };
  adquiriente: { nombre: string; identificacion: string; lineas: string[] };
  formaPago: string;
  medioPago?: string;
  lineas: LineaPdf[];
  /** Renglones del bloque de totales, en orden; el último es el total a pagar. */
  totales: { etiqueta: string; valor: number }[];
  totalPagar: number;
  cufe: string;
  qr: string;
  resolucion: string;
}

const TIPO_DOCUMENTO: Record<string, string> = {
  '11': 'RC',
  '12': 'TI',
  '13': 'CC',
  '21': 'TE',
  '22': 'CE',
  '31': 'NIT',
  '41': 'Pasaporte',
  '42': 'Doc. extranjero',
  '47': 'PEP',
  '48': 'PPT',
  '50': 'NIT de otro país',
};

const MEDIO_PAGO: Record<string, string> = {
  '1': 'Instrumento no definido',
  '10': 'Efectivo',
  '42': 'Consignación bancaria',
  '47': 'Transferencia débito bancaria',
  '48': 'Tarjeta crédito',
  '49': 'Tarjeta débito',
  ZZZ: 'Otro',
};

const fecha = (d: Date | string | undefined): string => {
  if (!d) return '';
  const t = d instanceof Date ? d : new Date(d);
  return Number.isNaN(t.getTime()) ? '' : t.toISOString().slice(0, 10);
};

/** Fecha y hora de Bogotá (UTC-5) de un instante ISO. */
const instanteBogota = (iso: unknown): string | undefined => {
  if (typeof iso !== 'string') return undefined;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return undefined;
  const b = new Date(t.getTime() - 5 * 3_600_000).toISOString();
  return `${b.slice(0, 10)} ${b.slice(11, 19)}`;
};

const porcentaje = (n: number | undefined): string => `${Number(n ?? 0).toLocaleString('es-CO')}%`;

function tributoDeLinea(l: ElectronicDocument['lines'][number]): string {
  const partes: string[] = [];
  if (l.taxScheme === '04') partes.push(`INC ${porcentaje(l.taxRate)}`);
  else if (l.taxScheme === '01') partes.push(`IVA ${porcentaje(l.taxRate)}`);
  else if (!l.taxScheme && (l.ivaRate ?? 0) > 0) partes.push(`IVA ${porcentaje(l.ivaRate)}`);
  if (l.perUnitTax && l.perUnitTax.valor > 0) partes.push('INC bolsas');
  return partes.join(' + ') || 'No gravado';
}

/** Normaliza el documento a lo que se dibuja. Sin CUFE no hay representación gráfica. */
export function datosRepresentacionDe(doc: DocumentoParaPdf): DatosRepresentacion {
  const cufe = doc.cufe?.trim();
  if (!cufe) throw new Error('El documento no tiene CUFE: no tiene representación gráfica.');
  const ambiente = (TIPOS_AMBIENTE as readonly string[]).includes(doc.tipoAmbiente ?? '')
    ? (doc.tipoAmbiente as TipoAmbiente)
    : '2';
  const e = doc.emisor ?? {};
  const a = doc.adquiriente ?? {};
  const r = doc.resolution ?? {};
  const nit = [e.nit ?? '', e.nitDv].filter(Boolean).join('-');

  const totales: { etiqueta: string; valor: number }[] = [
    { etiqueta: 'Subtotal (base gravable)', valor: doc.taxableBase ?? 0 },
  ];
  if ((doc.discountTotal ?? 0) > 0) totales.push({ etiqueta: 'Descuentos', valor: doc.discountTotal });
  totales.push({ etiqueta: 'IVA', valor: doc.ivaTotal ?? 0 });
  if (doc.incTotal !== undefined && doc.incTotal !== null) totales.push({ etiqueta: 'INC', valor: doc.incTotal });
  if ((doc.icaTotal ?? 0) > 0) totales.push({ etiqueta: 'ICA', valor: doc.icaTotal! });
  if ((doc.bagTaxTotal ?? 0) > 0) totales.push({ etiqueta: 'INC bolsas', valor: doc.bagTaxTotal! });
  for (const c of doc.charges ?? []) {
    totales.push({ etiqueta: c.chargeIndicator ? c.reason : `Descuento: ${c.reason}`, valor: c.amount });
  }
  const totalPagar = doc.payableAmount ?? doc.total;

  const ubicacion = [e.address, [e.ciudad, e.departamento].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
  const contacto = [e.phone ? `Tel. ${e.phone}` : '', e.email ?? ''].filter(Boolean).join(' · ');

  return {
    numero: doc.fullNumber,
    fecha: doc.issueDate,
    hora: doc.issueTime,
    validadoAt: instanteBogota(doc.respuestaDian?.recibidaAt),
    habilitacion: ambiente === '2',
    emisor: {
      nombre: e.name ?? '',
      nit,
      lineas: [
        [nit ? `NIT ${nit}` : '', e.responsabilidadFiscal ? `Resp. fiscal ${e.responsabilidadFiscal}` : '']
          .filter(Boolean)
          .join(' · '),
        ubicacion,
        contacto,
      ].filter(Boolean),
    },
    adquiriente: {
      nombre: a.name || 'Consumidor final',
      identificacion: [TIPO_DOCUMENTO[a.docType ?? ''] ?? 'Doc.', [a.docNumber, a.nitDv].filter(Boolean).join('-')]
        .filter(Boolean)
        .join(' '),
      lineas: [a.address ?? '', [a.phone ? `Tel. ${a.phone}` : '', a.email ?? ''].filter(Boolean).join(' · ')].filter(
        Boolean,
      ),
    },
    formaPago: doc.formaPago === '2' ? 'Crédito' : 'Contado',
    medioPago: doc.medioPago ? (MEDIO_PAGO[doc.medioPago] ?? `Código ${doc.medioPago}`) : undefined,
    lineas: (doc.lines ?? []).map((l) => ({
      codigo: l.code ?? '',
      descripcion: l.description,
      cantidad: Number(l.qty).toLocaleString('es-CO'),
      unitario: l.unitPrice,
      descuento: l.discountAmount ?? 0,
      base: l.base,
      tributo: tributoDeLinea(l),
      total: l.total,
    })),
    totales,
    totalPagar,
    cufe,
    qr: doc.qrUrl?.trim() || dianVerificationUrl(cufe, ambiente),
    resolucion:
      `Autorización de numeración de facturación DIAN N.º ${r.numero ?? '—'} del ${fecha(r.vigenciaDesde) || '—'}, ` +
      `vigente hasta ${fecha(r.vigenciaHasta) || '—'}. Rango autorizado: ${r.prefijo ?? ''} ${r.rangoDesde ?? '—'} ` +
      `a ${r.prefijo ?? ''} ${r.rangoHasta ?? '—'} (prefijo ${r.prefijo || 'sin prefijo'}).`,
  };
}

const money = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const INK = '#201f1d';
const MUTED = '#6f6a62';
const LINE = '#d9d4cc';
const ACCENT = '#3f4a5a';
const FONDO = '#eef1f6';

type Doc = InstanceType<typeof PDFDocument>;

/** Columnas de la tabla de líneas (anchos que suman el ancho útil de A4 con margen 36). */
const COLUMNAS = [
  { titulo: 'Código', ancho: 52, alinear: 'left' as const },
  { titulo: 'Descripción', ancho: 143, alinear: 'left' as const },
  { titulo: 'Cant.', ancho: 34, alinear: 'right' as const },
  { titulo: 'Vr. unitario', ancho: 58, alinear: 'right' as const },
  { titulo: 'Desc.', ancho: 44, alinear: 'right' as const },
  { titulo: 'Base', ancho: 60, alinear: 'right' as const },
  { titulo: 'Tributo', ancho: 70, alinear: 'center' as const },
  { titulo: 'Total', ancho: 62, alinear: 'right' as const },
];

/** Dibuja la factura y devuelve los bytes del PDF (A4). */
export function generarRepresentacionGrafica(d: DatosRepresentacion): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 36,
    info: { Title: `Factura electrónica ${d.numero}`, Subject: LEYENDA_REPRESENTACION, Producer: 'BookiPos' },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;

  if (d.habilitacion) {
    doc.rect(left, doc.y, width, 16).fill('#fbe9d0');
    doc
      .fillColor('#8a4b00')
      .font('Helvetica-Bold')
      .fontSize(8)
      .text('AMBIENTE DE HABILITACIÓN DE LA DIAN (PRUEBAS)', left, doc.y + 4, { width, align: 'center' });
    doc.y += 8;
  }

  // ── Encabezado: emisor (izquierda) y datos del documento (derecha) ─────────
  const top = doc.y;
  const anchoIzq = width * 0.58;
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(13).text(d.emisor.nombre, left, top, { width: anchoIzq });
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED);
  for (const l of d.emisor.lineas) doc.text(l, left, doc.y, { width: anchoIzq });
  const finIzq = doc.y;

  const xDer = left + anchoIzq + 10;
  const anchoDer = right - xDer;
  doc.fillColor(ACCENT).font('Helvetica-Bold').fontSize(10).text('FACTURA ELECTRÓNICA DE VENTA', xDer, top, {
    width: anchoDer,
    align: 'right',
  });
  doc.fillColor(INK).fontSize(12).text(`N.º ${d.numero}`, xDer, doc.y, { width: anchoDer, align: 'right' });
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED);
  const meta = [
    `Emisión: ${d.fecha} ${d.hora}`,
    d.validadoAt ? `Validación DIAN: ${d.validadoAt}` : '',
    `Forma de pago: ${d.formaPago}`,
    d.medioPago ? `Medio de pago: ${d.medioPago}` : '',
  ].filter(Boolean);
  for (const l of meta) doc.text(l, xDer, doc.y, { width: anchoDer, align: 'right' });
  doc.y = Math.max(finIzq, doc.y) + 8;
  hr(doc, left, right);
  doc.moveDown(0.5);

  // ── Adquiriente ────────────────────────────────────────────────────────────
  seccion(doc, left, 'Adquiriente');
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(10).text(d.adquiriente.nombre, left, doc.y, { width });
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED);
  doc.text(d.adquiriente.identificacion, left, doc.y, { width });
  for (const l of d.adquiriente.lineas) doc.text(l, left, doc.y, { width });
  doc.moveDown(0.6);

  // ── Líneas ─────────────────────────────────────────────────────────────────
  encabezadoTabla(doc, left, width);
  for (const l of d.lineas) {
    const celdas = [
      l.codigo,
      l.descripcion,
      l.cantidad,
      money.format(l.unitario),
      l.descuento ? money.format(l.descuento) : '',
      money.format(l.base),
      l.tributo,
      money.format(l.total),
    ];
    doc.font('Helvetica').fontSize(8);
    const alto =
      Math.max(...celdas.map((c, i) => doc.heightOfString(c || ' ', { width: COLUMNAS[i]!.ancho - 4 }))) + 4;
    if (doc.y + alto > doc.page.height - doc.page.margins.bottom - 40) {
      doc.addPage();
      encabezadoTabla(doc, left, width);
    }
    const y = doc.y;
    let x = left;
    celdas.forEach((c, i) => {
      const col = COLUMNAS[i]!;
      doc.fillColor(INK).text(c, x + 2, y + 2, { width: col.ancho - 4, align: col.alinear });
      x += col.ancho;
    });
    doc.y = y + alto;
    doc.strokeColor(LINE).lineWidth(0.5).moveTo(left, doc.y).lineTo(right, doc.y).stroke();
  }
  doc.moveDown(0.8);

  // ── Totales ────────────────────────────────────────────────────────────────
  const altoTotales = d.totales.length * 13 + 30;
  if (doc.y + altoTotales + 150 > doc.page.height - doc.page.margins.bottom) doc.addPage();
  const xTot = left + width * 0.5;
  const anchoTot = right - xTot;
  for (const t of d.totales) {
    const y = doc.y;
    doc.font('Helvetica').fontSize(9).fillColor(INK).text(t.etiqueta, xTot, y, { width: anchoTot * 0.6 });
    doc.text(money.format(t.valor), xTot, y, { width: anchoTot, align: 'right' });
    doc.y = y + 13;
  }
  const yTotal = doc.y + 2;
  doc.roundedRect(xTot, yTotal, anchoTot, 24, 4).fill(FONDO);
  doc
    .fillColor(ACCENT)
    .font('Helvetica-Bold')
    .fontSize(10.5)
    .text('Total a pagar', xTot + 8, yTotal + 7, { width: anchoTot * 0.5 });
  doc.text(money.format(d.totalPagar), xTot, yTotal + 7, { width: anchoTot - 8, align: 'right' });
  doc.y = yTotal + 34;

  // ── QR, CUFE, resolución y leyenda ────────────────────────────────────────
  const yPie = doc.y;
  const ladoQr = 104;
  dibujarQr(doc, d.qr, left, yPie, ladoQr);
  const xTexto = left + ladoQr + 14;
  const anchoTexto = right - xTexto;
  doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7.5).text('CUFE', xTexto, yPie, { width: anchoTexto });
  doc.fillColor(INK).font('Courier').fontSize(7.5);
  // El CUFE (96 caracteres) en dos renglones fijos: nunca lo parte el ajuste de línea.
  doc.text(d.cufe.slice(0, 48), xTexto, doc.y, { width: anchoTexto });
  doc.text(d.cufe.slice(48), xTexto, doc.y, { width: anchoTexto });
  doc.moveDown(0.5);
  doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7.5).text('Resolución de numeración', xTexto, doc.y, {
    width: anchoTexto,
  });
  doc.fillColor(INK).font('Helvetica').fontSize(7.5).text(d.resolucion, xTexto, doc.y, { width: anchoTexto });
  doc.moveDown(0.5);
  doc.fillColor(MUTED).fontSize(7.5).text(LEYENDA_REPRESENTACION, xTexto, doc.y, { width: anchoTexto });
  doc.text('Software propio: BookiPos.', xTexto, doc.y, { width: anchoTexto });
  doc.y = Math.max(doc.y, yPie + ladoQr);

  doc.end();
  return done;
}

function dibujarQr(doc: Doc, contenido: string, x: number, y: number, lado: number): void {
  const m = generarQrMatrix(contenido, 'M');
  const zonaQuieta = 2;
  const modulo = lado / (m.length + 2 * zonaQuieta);
  doc.save().fillColor('#000000');
  for (let fila = 0; fila < m.length; fila += 1) {
    for (let col = 0; col < m.length; col += 1) {
      if (m[fila]![col]) {
        doc.rect(x + (col + zonaQuieta) * modulo, y + (fila + zonaQuieta) * modulo, modulo, modulo);
      }
    }
  }
  doc.fill();
  doc.restore();
}

function hr(doc: Doc, left: number, right: number): void {
  doc.strokeColor(LINE).lineWidth(1).moveTo(left, doc.y).lineTo(right, doc.y).stroke();
}

function seccion(doc: Doc, left: number, titulo: string): void {
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED).text(titulo.toUpperCase(), left, doc.y, {
    characterSpacing: 0.5,
  });
  doc.moveDown(0.2);
}

function encabezadoTabla(doc: Doc, left: number, width: number): void {
  const y = doc.y;
  doc.rect(left, y, width, 15).fill(FONDO);
  let x = left;
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(ACCENT);
  for (const c of COLUMNAS) {
    doc.text(c.titulo, x + 2, y + 4, { width: c.ancho - 4, align: c.alinear });
    x += c.ancho;
  }
  doc.y = y + 15;
}
