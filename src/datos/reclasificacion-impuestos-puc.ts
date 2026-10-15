import type { Model } from 'mongoose';
import type { Conteo } from './en-cada-empresa';
import type { JournalEntryDocument } from '../modules/core-ledger/infrastructure/schemas/journal-entry.schema';
import type { LedgerAccountDocument } from '../modules/core-ledger/infrastructure/schemas/ledger-account.schema';
import type { PostEntryInput, PostLine } from '../modules/core-ledger/application/ledger.service';
import {
  ORIGENES_IVA_INC_VIEJO,
  RECLASIFICACIONES,
  SEED_ACCOUNTS,
} from '../modules/core-ledger/domain/ledger.constants';
import { cop } from '../modules/finance/domain/money.util';

/**
 * Reclasificación de saldos por el cambio de cuentas del PUC (Decreto 2650/93).
 *
 * Hasta octubre de 2026 el posteo automático mandaba el IVA generado a la 2367 y
 * el INC a la 2368. En el PUC esas son las retenciones practicadas (ReteIVA y
 * ReteICA); el IVA por pagar es la 2408 y el INC por pagar la 2495. El código ya
 * postea a las cuentas correctas; este módulo traslada lo que quedó en las
 * viejas con UN asiento de reclasificación a la fecha de corte, por sede.
 *
 * - No edita asientos viejos: el asiento es inmutable (CLAUDE.md, invariante 2).
 *   Se postea por `LedgerService.post`, la única puerta de escritura.
 * - Idempotente por estado: reclasifica el saldo de 2367/2368 a la fecha de
 *   corte. Tras aplicarlo ese saldo es 0 y repetir no hace nada. Si después del
 *   corte entra algo a las cuentas viejas, se corre otra vez con un corte
 *   posterior y traslada solo ese residuo. La reversa de un asiento viejo ya no
 *   lo hace: `LedgerService.reverse` remapea 2367/2368 a 2408/2495.
 * - Un corte ANTERIOR a una reclasificación ya hecha se rechaza: su saldo a esa
 *   fecha no ve el asiento posterior y lo reclasificaría dos veces.
 * - Solo mira asientos de venta/devolución automáticos (y sus reversas y las
 *   reclasificaciones): un asiento manual con 2367/2368 es una retención real.
 */

/** Cuenta vieja → cuenta PUC correcta. Vive en el dominio del ledger: la reversa también la usa. */
export { RECLASIFICACIONES };

/** `sourceType` del asiento de reclasificación (y su contra-asiento, si lo hubiera). */
export const SOURCE_RECLASIFICACION = 'reclasificacion_puc';

const MEMO =
  'Reclasificación PUC (Decreto 2650/93): IVA 2367→2408, INC 2368→2495';

/** Saldo acumulado de una cuenta vieja en una sede (renglones sin sede: `null`). */
export interface SaldoCuenta {
  accountCode: string;
  sedeId: string | null;
  debit: number;
  credit: number;
}

/** Modelos y servicio que usa el script, ya resueltos contra la empresa activa. */
export interface DepsReclasificacion {
  entries: Model<JournalEntryDocument>;
  accounts: Model<LedgerAccountDocument>;
  post: (input: PostEntryInput) => Promise<unknown>;
}

export const USO_CORTE =
  'Falta --corte YYYY-MM-DD (hoy o antes, fecha de Colombia): la fecha del asiento y hasta la que se toma el saldo.';

/** Fecha (YYYY-MM-DD) en Colombia: un servidor en UTC va 5 horas adelante. */
export function hoyColombia(ahora: Date = new Date()): string {
  return ahora.toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
}

/**
 * Lee `--corte YYYY-MM-DD`. `null` si falta, no es una fecha válida o es
 * posterior a hoy: un corte futuro postea hoy un asiento fechado después, deja
 * fuera lo que entre a las cuentas viejas hasta esa fecha y, como un corte
 * anterior a una reclasificación ya hecha se rechaza, no habría cómo corregirlo.
 */
export function leerCorte(argv: string[], hoy: string = hoyColombia()): string | null {
  const i = argv.indexOf('--corte');
  const valor = i >= 0 ? argv[i + 1] : undefined;
  if (!valor || !/^\d{4}-\d{2}-\d{2}$/.test(valor)) return null;
  const fecha = new Date(`${valor}T00:00:00Z`);
  if (Number.isNaN(fecha.getTime())) return null;
  // Rechaza 2026-02-31 y similares: Date los desborda al mes siguiente.
  if (fecha.toISOString().slice(0, 10) !== valor) return null;
  return valor <= hoy ? valor : null;
}

/**
 * Renglones del asiento. Por cada cuenta vieja y sede, el saldo (natural
 * crédito, es pasivo) sale de la vieja y entra a la nueva. Si el saldo fuera
 * deudor —devoluciones que superan lo causado— se traslada igual, al revés.
 */
export function renglonesDeReclasificacion(saldos: SaldoCuenta[]): PostLine[] {
  const hacia = new Map(RECLASIFICACIONES.map((r) => [r.desde, r.hacia]));
  const lines: PostLine[] = [];
  for (const s of saldos) {
    const destino = hacia.get(s.accountCode);
    if (!destino) continue;
    const saldo = cop(s.credit - s.debit);
    if (saldo === 0) continue;
    const monto = Math.abs(saldo);
    const sedeId = s.sedeId ?? undefined;
    const memo = `${s.accountCode} → ${destino}`;
    if (saldo > 0) {
      lines.push({ accountCode: s.accountCode, debit: monto, sedeId, memo });
      lines.push({ accountCode: destino, credit: monto, sedeId, memo });
    } else {
      lines.push({ accountCode: s.accountCode, credit: monto, sedeId, memo });
      lines.push({ accountCode: destino, debit: monto, sedeId, memo });
    }
  }
  return lines;
}

/**
 * Orígenes cuyo saldo en 2367/2368 es IVA/INC del plan viejo: las ventas y
 * devoluciones automáticas, sus contra-asientos y las propias
 * reclasificaciones (sin ellas no se vería que el saldo ya se trasladó). Un
 * asiento manual con 2367/2368 es ReteIVA/ReteICA de verdad y no se toca.
 */
const ORIGENES_RECLASIFICABLES = [
  ...ORIGENES_IVA_INC_VIEJO,
  SOURCE_RECLASIFICACION,
].flatMap((s) => [s, `reversal:${s}`]);

/** Saldo de 2367/2368 por sede con todo lo posteado hasta el corte (inclusive). */
export async function saldosAlCorte(
  entries: Model<JournalEntryDocument>,
  corte: string,
): Promise<SaldoCuenta[]> {
  const desde = RECLASIFICACIONES.map((r) => r.desde);
  const rows = (await entries
    .aggregate([
      {
        $match: {
          date: { $lte: corte },
          sourceType: { $in: ORIGENES_RECLASIFICABLES },
          'lines.accountCode': { $in: desde },
        },
      },
      { $unwind: '$lines' },
      { $match: { 'lines.accountCode': { $in: desde } } },
      {
        $group: {
          _id: { code: '$lines.accountCode', sedeId: '$lines.sedeId' },
          debit: { $sum: '$lines.debit' },
          credit: { $sum: '$lines.credit' },
        },
      },
    ])
    .exec()) as {
    _id: { code: string; sedeId?: { toString(): string } | null };
    debit: number;
    credit: number;
  }[];
  return rows.map((r) => ({
    accountCode: r._id.code,
    sedeId: r._id.sedeId ? r._id.sedeId.toString() : null,
    debit: r.debit,
    credit: r.credit,
  }));
}

/** Nombre PUC que debe tener cada cuenta vieja (el de la siembra). */
function nombrePuc(code: string): string {
  return SEED_ACCOUNTS.find((a) => a.code === code)?.name ?? code;
}

/**
 * Lo que falta por corregir en la empresa activa. Tras aplicar debe quedar todo
 * en 0. Solo lee.
 */
export async function contarReclasificacion(
  deps: Pick<DepsReclasificacion, 'entries' | 'accounts'>,
  corte: string,
): Promise<Conteo> {
  const saldos = await saldosAlCorte(deps.entries, corte);
  const conteo: Conteo = {};
  for (const { desde } of RECLASIFICACIONES) {
    conteo[`saldo${desde}`] = saldos
      .filter((s) => s.accountCode === desde)
      .reduce((a, s) => a + Math.abs(cop(s.credit - s.debit)), 0);
  }
  let nombresViejos = 0;
  for (const { desde } of RECLASIFICACIONES) {
    const cuenta = await deps.accounts.findOne({ code: desde }).exec();
    if (cuenta && cuenta.system && cuenta.name !== nombrePuc(desde)) nombresViejos++;
  }
  conteo.nombresViejos = nombresViejos;
  return conteo;
}

/**
 * Postea el asiento de reclasificación y deja a 2367/2368 con su nombre PUC.
 * Idempotente: sin saldo a la fecha de corte no postea nada, y el renombre
 * solo toca las cuentas `system` que aún tienen el nombre viejo.
 */
export async function aplicarReclasificacion(
  deps: DepsReclasificacion,
  corte: string,
): Promise<void> {
  const posterior = await deps.entries
    .findOne({ sourceType: SOURCE_RECLASIFICACION, date: { $gt: corte } })
    .exec();
  if (posterior) {
    throw new Error(
      `Ya hay una reclasificación del ${posterior.date}, posterior al corte ${corte}: usa un corte igual o posterior.`,
    );
  }

  const lines = renglonesDeReclasificacion(await saldosAlCorte(deps.entries, corte));
  if (lines.length > 0) {
    await deps.post({
      date: corte,
      sourceType: SOURCE_RECLASIFICACION,
      sourceId: corte,
      memo: MEMO,
      lines,
      createdByEmail: 'datos:reclasificacion-puc',
    });
  }

  for (const { desde } of RECLASIFICACIONES) {
    const nombre = nombrePuc(desde);
    await deps.accounts
      .updateOne({ code: desde, system: true, name: { $ne: nombre } }, { $set: { name: nombre } })
      .exec();
  }
}
