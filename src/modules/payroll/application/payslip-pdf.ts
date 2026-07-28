import PDFDocument from 'pdfkit';
import { PayrollBreakdown } from '../domain/payroll-calc';

export interface PayslipEmployer {
  name: string;
  nit?: string;
  address?: string;
  phone?: string;
}

export interface PayslipEmployee {
  name: string;
  docNumber?: string;
  position?: string;
  salarioBase: number;
}

export interface PayslipPdfData {
  employer: PayslipEmployer;
  employee: PayslipEmployee;
  /** Período de la corrida (ej. "2026-07"). */
  period: string;
  /** Etiqueta opcional de la corrida. */
  periodLabel?: string;
  breakdown: PayrollBreakdown;
}

const money = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

// Paleta discreta acorde a la representación de la UI.
const INK = '#201f1d';
const MUTED = '#8a857c';
const LINE = '#e8e4de';
const ACCENT = '#3f4a5a';

/**
 * Genera el comprobante/desprendible de pago de nómina en PDF (una página A4).
 * Devuelve el Buffer del documento para adjuntarlo a un correo.
 */
export function buildPayslipPdf(data: PayslipPdfData): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;
  const b = data.breakdown;
  const d = b.devengados;
  const de = b.deducciones;
  const ap = b.aportesEmpleador;
  const pr = b.provisiones;

  // ── Encabezado: emisor + título ────────────────────────────────────────────
  doc
    .fillColor(INK)
    .font('Helvetica-Bold')
    .fontSize(15)
    .text(data.employer.name, left, doc.y, { width });
  doc.font('Helvetica').fontSize(9).fillColor(MUTED);
  const emisorLine = [
    data.employer.nit ? `NIT ${data.employer.nit}` : null,
    data.employer.address,
    data.employer.phone ? `Tel. ${data.employer.phone}` : null,
  ]
    .filter(Boolean)
    .join('  ·  ');
  if (emisorLine) doc.text(emisorLine, { width });

  doc.moveDown(0.4);
  doc
    .fillColor(ACCENT)
    .font('Helvetica-Bold')
    .fontSize(12)
    .text('Comprobante de pago de nómina', { width });
  doc
    .fillColor(MUTED)
    .font('Helvetica')
    .fontSize(9)
    .text(
      `Período ${data.period}${data.periodLabel ? ` · ${data.periodLabel}` : ''}`,
      { width },
    );

  doc.moveDown(0.6);
  hr(doc, left, right);
  doc.moveDown(0.6);

  // ── Datos del empleado ─────────────────────────────────────────────────────
  const startY = doc.y;
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(11).text(data.employee.name, left, startY);
  doc.font('Helvetica').fontSize(9).fillColor(MUTED);
  const empLine = [
    data.employee.docNumber ? `Doc. ${data.employee.docNumber}` : null,
    data.employee.position ?? 'Sin cargo',
    `${b.diasTrabajados} días laborados`,
  ]
    .filter(Boolean)
    .join('  ·  ');
  doc.text(empLine, left);
  // Columna derecha: salario base.
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor(MUTED)
    .text('Salario base', left, startY, { width, align: 'right' });
  doc
    .font('Helvetica-Bold')
    .fontSize(11)
    .fillColor(INK)
    .text(money.format(data.employee.salarioBase), left, startY + 12, {
      width,
      align: 'right',
    });

  doc.moveDown(1.2);

  // ── Devengados ─────────────────────────────────────────────────────────────
  section(doc, left, right, 'Devengados');
  row(doc, left, right, `Salario (${b.diasTrabajados} días)`, money.format(d.salario));
  if (d.auxilioTransporte)
    row(doc, left, right, 'Auxilio de transporte', money.format(d.auxilioTransporte));
  for (const r of d.recargoDetalle) {
    row(doc, left, right, `${r.label} (${r.horas}h)`, money.format(r.valor), true);
  }
  if (d.bonificacionSalarial)
    row(doc, left, right, 'Bonificación salarial', money.format(d.bonificacionSalarial));
  if (d.bonificacionNoSalarial)
    row(doc, left, right, 'Bonificación no salarial', money.format(d.bonificacionNoSalarial));
  if (d.comisiones) row(doc, left, right, 'Comisiones', money.format(d.comisiones));
  totalRow(doc, left, right, 'Total devengado', money.format(d.total));

  // ── Deducciones ────────────────────────────────────────────────────────────
  section(doc, left, right, 'Deducciones');
  row(doc, left, right, 'Salud (4%)', `− ${money.format(de.salud)}`);
  row(doc, left, right, 'Pensión (4%)', `− ${money.format(de.pension)}`);
  if (de.fsp)
    row(doc, left, right, 'Fondo de solidaridad pensional', `− ${money.format(de.fsp)}`);
  if (de.retencionFuente)
    row(
      doc,
      left,
      right,
      `Retención en la fuente (${b.baseRetencionUvt} UVT)`,
      `− ${money.format(de.retencionFuente)}`,
    );
  if (de.otras) row(doc, left, right, 'Otras deducciones', `− ${money.format(de.otras)}`);
  totalRow(doc, left, right, 'Total deducciones', `− ${money.format(de.total)}`);

  // ── Neto a pagar ───────────────────────────────────────────────────────────
  doc.moveDown(0.6);
  const netY = doc.y;
  doc.roundedRect(left, netY, width, 30, 6).fill('#eef1f6');
  doc
    .fillColor(ACCENT)
    .font('Helvetica-Bold')
    .fontSize(11)
    .text('Neto a pagar', left + 12, netY + 9, { width: width / 2 });
  doc
    .fillColor(ACCENT)
    .font('Helvetica-Bold')
    .fontSize(14)
    .text(money.format(b.netoPagar), left, netY + 7, { width: width - 12, align: 'right' });
  doc.y = netY + 30;
  doc.moveDown(0.6);

  // ── Aportes patronales (informativo) ───────────────────────────────────────
  section(doc, left, right, 'Aportes del empleador (no se descuentan)');
  row(doc, left, right, 'Salud (8,5%)', money.format(ap.salud), true);
  row(doc, left, right, 'Pensión (12%)', money.format(ap.pension), true);
  row(doc, left, right, 'ARL', money.format(ap.arl), true);
  row(doc, left, right, 'Caja de compensación (4%)', money.format(ap.ccf), true);
  if (ap.sena) row(doc, left, right, 'SENA (2%)', money.format(ap.sena), true);
  if (ap.icbf) row(doc, left, right, 'ICBF (3%)', money.format(ap.icbf), true);
  totalRow(doc, left, right, 'Total aportes', money.format(ap.total), true);

  // ── Provisiones (informativo) ──────────────────────────────────────────────
  section(doc, left, right, 'Provisiones prestacionales');
  row(doc, left, right, 'Cesantías (8,33%)', money.format(pr.cesantias), true);
  row(doc, left, right, 'Intereses cesantías (12%)', money.format(pr.interesesCesantias), true);
  row(doc, left, right, 'Prima de servicios (8,33%)', money.format(pr.prima), true);
  row(doc, left, right, 'Vacaciones (4,17%)', money.format(pr.vacaciones), true);
  totalRow(doc, left, right, 'Total provisiones', money.format(pr.total), true);

  // ── Pie ────────────────────────────────────────────────────────────────────
  doc.moveDown(0.6);
  hr(doc, left, right);
  doc.moveDown(0.4);
  const footY = doc.y;
  doc
    .font('Helvetica-Bold')
    .fontSize(10)
    .fillColor(INK)
    .text('Costo total empleador', left, footY, { width: width / 2 });
  doc
    .font('Helvetica-Bold')
    .fontSize(10)
    .fillColor(INK)
    .text(money.format(b.costoEmpleador), left, footY, { width, align: 'right' });
  doc.moveDown(0.3);
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor(MUTED)
    .text(
      `IBC: ${money.format(b.ibc)}  ·  Hora ordinaria: ${money.format(b.horaOrdinaria)}`,
      left,
      doc.y,
      { width },
    );
  doc
    .fontSize(8)
    .fillColor(MUTED)
    .text(
      'Comprobante de pago de salarios (art. 138 CST). No constituye documento soporte de nómina electrónica ante la DIAN.',
      left,
      doc.y + 4,
      { width },
    );

  doc.end();
  return done;
}

// ── Helpers de dibujo ──────────────────────────────────────────────────────────
type Doc = InstanceType<typeof PDFDocument>;

function hr(doc: Doc, left: number, right: number): void {
  doc
    .strokeColor(LINE)
    .lineWidth(1)
    .moveTo(left, doc.y)
    .lineTo(right, doc.y)
    .stroke();
}

function section(doc: Doc, left: number, right: number, title: string): void {
  doc.moveDown(0.5);
  doc
    .font('Helvetica-Bold')
    .fontSize(8)
    .fillColor(MUTED)
    .text(title.toUpperCase(), left, doc.y, { characterSpacing: 0.5 });
  doc.moveDown(0.2);
}

function row(
  doc: Doc,
  left: number,
  right: number,
  label: string,
  value: string,
  muted = false,
): void {
  const y = doc.y;
  const width = right - left;
  doc
    .font('Helvetica')
    .fontSize(9.5)
    .fillColor(muted ? MUTED : INK)
    .text(label, left, y, { width: width * 0.62 });
  doc
    .font('Helvetica')
    .fontSize(9.5)
    .fillColor(muted ? MUTED : INK)
    .text(value, left, y, { width, align: 'right' });
  doc.y = y + 13;
}

function totalRow(
  doc: Doc,
  left: number,
  right: number,
  label: string,
  value: string,
  muted = false,
): void {
  doc.moveDown(0.15);
  hr(doc, left, right);
  doc.moveDown(0.2);
  const y = doc.y;
  const width = right - left;
  doc
    .font('Helvetica-Bold')
    .fontSize(10)
    .fillColor(muted ? MUTED : INK)
    .text(label, left, y, { width: width * 0.62 });
  doc
    .font('Helvetica-Bold')
    .fontSize(10)
    .fillColor(muted ? MUTED : INK)
    .text(value, left, y, { width, align: 'right' });
  doc.y = y + 14;
}
