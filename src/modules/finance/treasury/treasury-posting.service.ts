import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  FinanceAccount,
  FinanceAccountDocument,
} from '../infrastructure/schemas/finance-account.schema';
import {
  FinanceMovement,
  FinanceMovementDocument,
} from '../infrastructure/schemas/finance-movement.schema';
import {
  FinancePaymentMethod,
  MovementDirection,
  MovementSource,
} from '../domain/finance.constants';
import { cop } from '../domain/money.util';

/** Datos de un auto-posteo a tesorería. */
export interface TreasuryPost {
  sourceType: MovementSource;
  sourceId: string;
  sedeId?: string | null;
  method: FinancePaymentMethod;
  direction: MovementDirection;
  amount: number;
  date: string; // YYYY-MM-DD
  concept: string;
  categoryId?: string | null;
}

/**
 * Alimenta la tesorería (cuentas de banco/billetera) desde las operaciones:
 * ventas con tarjeta/transferencia, pagos de gastos/CxP y cobros de CxC. Es
 * **best-effort** (un fallo se loguea y NO tumba la operación, igual que el
 * ledger) e **idempotente** por `(sourceType, sourceId)`.
 *
 * El efectivo NO pasa por aquí: su fuente de verdad es la caja del POS.
 * Servicio compartido (patrón LedgerPostingService) para que Sales y Finance lo
 * usen sin acoplar módulos pesados.
 */
@Injectable()
export class TreasuryPostingService {
  private readonly logger = new Logger(TreasuryPostingService.name);

  constructor(
    @InjectModel(FinanceAccount.name)
    private readonly accounts: Model<FinanceAccountDocument>,
    @InjectModel(FinanceMovement.name)
    private readonly movements: Model<FinanceMovementDocument>,
  ) {}

  /**
   * Cuenta destino para un método+sede: la cuenta activa cuyo `autoMethods`
   * incluye el método, priorizando la de la sede exacta sobre la consolidada.
   */
  private async accountForMethod(
    method: FinancePaymentMethod,
    sedeId?: string | null,
  ): Promise<FinanceAccountDocument | null> {
    const accts = await this.accounts
      .find({ active: true, autoMethods: method })
      .exec();
    if (accts.length === 0) return null;
    if (sedeId) {
      const own = accts.find((a) => a.sedeId?.toString() === sedeId);
      if (own) return own;
    }
    return accts.find((a) => !a.sedeId) ?? null;
  }

  /**
   * Postea un movimiento auto a la cuenta mapeada. Si no hay cuenta para el
   * método, no hace nada (la operación no se bloquea). Devuelve la cuenta o null.
   */
  async post(p: TreasuryPost): Promise<void> {
    const amount = cop(p.amount);
    if (amount <= 0) return;
    try {
      const acc = await this.accountForMethod(p.method, p.sedeId ?? null);
      if (!acc) return;
      await this.movements.create({
        accountId: acc._id,
        sedeId: acc.sedeId ?? (p.sedeId ? new Types.ObjectId(p.sedeId) : null),
        date: p.date,
        direction: p.direction,
        amount,
        categoryId: p.categoryId ? new Types.ObjectId(p.categoryId) : undefined,
        concept: p.concept,
        reconciled: false,
        sourceType: p.sourceType,
        sourceId: p.sourceId,
        auto: true,
        createdByEmail: 'sistema',
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) return; // ya posteado (idempotente)
      this.logger.warn(
        `No se pudo auto-postear a tesorería (${p.sourceType}:${p.sourceId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Elimina el movimiento auto de una operación (al anular venta, etc.). */
  async reverse(sourceType: MovementSource, sourceId: string): Promise<void> {
    try {
      await this.movements
        .deleteMany({ sourceType, sourceId, auto: true })
        .exec();
    } catch (err) {
      this.logger.warn(
        `No se pudo reversar tesorería (${sourceType}:${sourceId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

/** ¿El error es un duplicado por índice único de Mongo (E11000)? */
function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: number }).code === 11000
  );
}
