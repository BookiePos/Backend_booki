import { cop } from './money.util';
import {
  CARD_FRANCHISES,
  PAYMENT_CHANNELS,
  PaymentChannel,
} from '../../sales/domain/sales.constants';
import { SalePaymentsView, salePartsOf } from '../../sales/domain/sale-payments';

/**
 * Conciliación de pagos digitales contra el extracto (ítem 6.4).
 *
 * Se cruza, por día y por canal (datáfono por franquicia, Nequi, Daviplata,
 * QR), lo que el POS cobró contra lo que el adquirente o la billetera
 * consignaron. Lo que falta para llegar al bruto es comisión, IVA de la
 * comisión y retenciones: se asienta; lo que no se explica queda como
 * diferencia visible.
 */

/** Canales conciliables: los del POS más la transferencia bancaria simple. */
export const RECON_CHANNELS = [...PAYMENT_CHANNELS, 'transferencia'] as const;
export type ReconChannel = (typeof RECON_CHANNELS)[number];

export const RECON_CHANNEL_LABEL: Record<ReconChannel, string> = {
  datafono: 'Datáfono',
  nequi: 'Nequi',
  daviplata: 'Daviplata',
  qr: 'QR / Bre-B',
  transferencia: 'Transferencia',
};

/** Franquicia vacía = sin dato (ventas de antes del 6.4 o sin elegir). */
export function reconKey(channel: ReconChannel, franchise?: string): string {
  return channel === 'datafono' && franchise ? `datafono:${franchise}` : channel;
}

export interface ExpectedRow {
  date: string;
  channel: ReconChannel;
  franchise: string;
  key: string;
  /** Lo cobrado por ese canal ese día (bruto, con propina y domicilio). */
  expected: number;
  tickets: number;
}

export interface SaleForRecon extends SalePaymentsView {
  createdAt: Date;
}

/**
 * Lo que el POS cobró por cada canal digital y día. La fecha es la del día
 * contable de Colombia (el llamador pasa `fecha`). El efectivo y el fiado no
 * entran; una tarjeta sin canal (ventas de antes) cuenta como datáfono y una
 * transferencia sin canal, como transferencia.
 */
export function expectedByDay(
  sales: readonly SaleForRecon[],
  fecha: (d: Date) => string,
): ExpectedRow[] {
  const rows = new Map<string, ExpectedRow>();
  for (const sale of sales) {
    const date = fecha(sale.createdAt);
    const seen = new Set<string>();
    for (const p of salePartsOf(sale)) {
      let channel: ReconChannel | undefined = p.channel;
      if (!channel) {
        if (p.method === 'card') channel = 'datafono';
        else if (p.method === 'transfer') channel = 'transferencia';
      }
      if (!channel) continue;
      const franchise = channel === 'datafono' ? (p.franchise ?? '') : '';
      const key = reconKey(channel, franchise);
      const id = `${date}|${key}`;
      const row = rows.get(id) ?? { date, channel, franchise, key, expected: 0, tickets: 0 };
      row.expected = cop(row.expected + p.amount);
      if (!seen.has(id)) {
        row.tickets += 1;
        seen.add(id);
      }
      rows.set(id, row);
    }
  }
  return [...rows.values()].sort((a, b) =>
    a.date === b.date ? a.key.localeCompare(b.key) : a.date.localeCompare(b.date),
  );
}

export interface SettlementFigures {
  expected: number;
  statementAmount: number;
  commission: number;
  commissionIva: number;
  retefuente: number;
  reteIca: number;
  reteIva: number;
}

/** Cobrado − (consignado + comisión + IVA + retenciones). 0 = cuadra. */
export function settlementDifference(f: SettlementFigures): number {
  return cop(
    f.expected -
      (f.statementAmount + f.commission + f.commissionIva + f.retefuente + f.reteIca + f.reteIva),
  );
}

// ── CSV del extracto ──────────────────────────────────────────────────────────

export interface ParsedStatementRow {
  line: number;
  date: string;
  channel: ReconChannel;
  franchise: string;
  statementAmount: number;
  commission: number;
  commissionIva: number;
  retefuente: number;
  reteIca: number;
  reteIva: number;
}

export interface ParsedStatement {
  rows: ParsedStatementRow[];
  errors: { line: number; message: string }[];
}

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const COLUMNS: Record<string, string[]> = {
  date: ['fecha', 'fecha abono', 'fecha pago', 'fecha consignacion', 'date'],
  channel: ['canal', 'medio', 'tipo', 'channel'],
  franchise: ['franquicia', 'marca', 'tarjeta', 'franchise'],
  gross: ['bruto', 'valor bruto', 'ventas', 'valor venta', 'total ventas'],
  net: ['neto', 'valor neto', 'consignado', 'abono', 'valor consignado', 'valor abonado', 'net'],
  commission: ['comision', 'valor comision', 'comision adquirente'],
  commissionIva: ['iva', 'iva comision'],
  retefuente: ['retefuente', 'retencion', 'retencion fuente', 'rete fuente'],
  reteIca: ['reteica', 'rete ica'],
  reteIva: ['reteiva', 'rete iva'],
};

/** Monto en pesos: "1.234.567", "1,234,567", "$ 1234567" o "1234567,00". */
export function parseCopAmount(raw: string): number | null {
  const t = raw.replace(/[$\s]/g, '');
  if (t === '') return 0;
  if (/^-?\d{1,3}([.,]\d{3})+$/.test(t)) return cop(Number(t.replace(/[.,]/g, '')));
  if (/^-?\d+([.,]\d{1,2})?$/.test(t)) return cop(Number(t.replace(',', '.')));
  return null;
}

/** Fecha YYYY-MM-DD o DD/MM/YYYY (también con guiones). */
export function parseStatementDate(raw: string): string | null {
  const t = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(t);
  if (m) return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  return null;
}

function splitLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === sep && !quoted) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

function channelOf(raw: string): { channel: ReconChannel; franchise: string } | null {
  const t = norm(raw);
  if (!t) return null;
  const franchise = CARD_FRANCHISES.find((f) => t.includes(f));
  if (franchise) return { channel: 'datafono', franchise };
  if (/datafono|tarjeta|pos|credito|debito/.test(t)) return { channel: 'datafono', franchise: '' };
  if (t.includes('nequi')) return { channel: 'nequi', franchise: '' };
  if (t.includes('daviplata')) return { channel: 'daviplata', franchise: '' };
  if (/qr|bre b|breb|llave/.test(t)) return { channel: 'qr', franchise: '' };
  if (/transfer|pse|consignacion/.test(t)) return { channel: 'transferencia', franchise: '' };
  return null;
}

/**
 * Lee el CSV del extracto (coma o punto y coma). Necesita una fila de
 * encabezados con al menos `fecha` y `neto`/`bruto`. El canal sale de la
 * columna canal/medio/franquicia o, si no hay, de `defaultChannel`.
 */
export function parseStatementCsv(
  text: string,
  defaultChannel?: ReconChannel,
): ParsedStatement {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const first = lines.findIndex((l) => l.trim() !== '');
  const result: ParsedStatement = { rows: [], errors: [] };
  if (first < 0) {
    result.errors.push({ line: 1, message: 'El archivo está vacío' });
    return result;
  }
  const sep = (lines[first]!.match(/;/g)?.length ?? 0) > (lines[first]!.match(/,/g)?.length ?? 0) ? ';' : ',';
  const headers = splitLine(lines[first]!, sep).map(norm);
  const idx: Record<string, number> = {};
  for (const [field, names] of Object.entries(COLUMNS)) {
    const i = headers.findIndex((h) => names.includes(h));
    if (i >= 0) idx[field] = i;
  }
  if (idx.date === undefined || (idx.net === undefined && idx.gross === undefined)) {
    result.errors.push({
      line: first + 1,
      message: 'Faltan columnas: se necesita al menos «fecha» y «neto» (o «bruto»)',
    });
    return result;
  }

  for (let i = first + 1; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.trim() === '') continue;
    const line = i + 1;
    const cells = splitLine(raw, sep);
    const cell = (f: string) => (idx[f] === undefined ? '' : (cells[idx[f]!] ?? ''));
    const date = parseStatementDate(cell('date'));
    if (!date) {
      result.errors.push({ line, message: 'Fecha inválida (usa YYYY-MM-DD o DD/MM/AAAA)' });
      continue;
    }
    const money = (f: string) => parseCopAmount(cell(f));
    const fields = ['commission', 'commissionIva', 'retefuente', 'reteIca', 'reteIva', 'net', 'gross'];
    const vals: Record<string, number | null> = {};
    for (const f of fields) vals[f] = money(f);
    const bad = fields.find((f) => vals[f] === null);
    if (bad) {
      result.errors.push({ line, message: `Monto inválido en «${bad}»` });
      continue;
    }
    const fromCell = channelOf(cell('channel')) ?? channelOf(cell('franchise'));
    const base = fromCell ?? (defaultChannel ? { channel: defaultChannel, franchise: '' } : null);
    if (!base) {
      result.errors.push({ line, message: 'No se reconoce el canal: agrega la columna «canal» o elige uno' });
      continue;
    }
    const franchise = cell('franchise') ? (channelOf(cell('franchise'))?.franchise ?? base.franchise) : base.franchise;
    const fees =
      vals.commission! + vals.commissionIva! + vals.retefuente! + vals.reteIca! + vals.reteIva!;
    const net = idx.net !== undefined ? vals.net! : cop(vals.gross! - fees);
    if (net < 0) {
      result.errors.push({ line, message: 'El valor consignado no puede ser negativo' });
      continue;
    }
    result.rows.push({
      line,
      date,
      channel: base.channel,
      franchise: base.channel === 'datafono' ? franchise : '',
      statementAmount: net,
      commission: vals.commission!,
      commissionIva: vals.commissionIva!,
      retefuente: vals.retefuente!,
      reteIca: vals.reteIca!,
      reteIva: vals.reteIva!,
    });
  }
  return result;
}

export function isReconChannel(v: string): v is ReconChannel {
  return (RECON_CHANNELS as readonly string[]).includes(v);
}

export type { PaymentChannel };
