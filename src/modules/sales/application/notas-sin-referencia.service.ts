import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  NotaSinReferencia,
  NotaSinReferenciaDocument,
} from '../infrastructure/schemas/nota-sin-referencia.schema';
import {
  FinanceReceivable,
  FinanceReceivableDocument,
} from '../../finance/infrastructure/schemas/finance-receivable.schema';
import { CreateNotaSinReferenciaDto } from './dto/create-sale-rebate.dto';
import { NotaFiscalVentaService } from './nota-fiscal-venta.service';
import { SaldoFavorService } from './saldo-favor.service';
import { CajaService } from '../../caja/application/caja.service';
import { CustomersService } from '../../customers/application/customers.service';
import { LedgerPostingService } from '../../core-ledger/application/ledger-posting.service';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { assertSedeAccess } from '../../core-auth/domain/sede-access';
import { fechaColombia } from '../../core-ledger/domain/fecha-contable';
import { origenNotaSinReferencia } from '../domain/documento-fiscal';
import { clampNonNegative, cop } from '../../finance/domain/money.util';
import type { NotaSinReferenciaEmitida } from './emision-documento-fiscal.puerto';

/** Llave del abono a la cartera en `ajustes.returnId` de la CxC. */
const llaveCartera = (id: string) => `sin_referencia:${id}`;

/**
 * Descuento posterior SIN referencia (Fase 6C): la nota crédito 22 de la FEV
 * que cubre las facturas de un cliente en un periodo, con su salida de plata
 * y su asiento.
 *
 * Mismo orden que la devolución: el registro (con la llave) antes de nada;
 * luego la cartera viva del cliente y la nota, que FALLA CERRADO (sin
 * facturas, por encima del tope, sin PIN): si la nota falla se deshace el
 * abono y se retira el registro. Después la caja y el asiento, cada uno con
 * su marca para que el reintento con la misma llave (o el barrido de
 * varadas) complete solo lo que falte.
 *
 * Cartera viva: como en la devolución de un fiado, lo que el cliente todavía
 * debe se abona primero (Cr 1305 y `finance_receivables`); solo el excedente
 * va por el medio elegido.
 *
 * Asiento (`nota_sin_referencia`): Db 4175 por la base, 2408/2495 por el
 * impuesto que reparte la nota; Cr 1305 por el abono y caja, bancos o 2805
 * por el resto.
 */
@Injectable()
export class NotasSinReferenciaService {
  private readonly logger = new Logger(NotasSinReferenciaService.name);
  static readonly TURNO_MS = 5 * 60 * 1000;
  /** Antigüedad a partir de la cual el barrido toma una operación varada. */
  static readonly VARADA_MS = 10 * 60 * 1000;

  constructor(
    @InjectModel(NotaSinReferencia.name)
    private readonly model: Model<NotaSinReferenciaDocument>,
    private readonly customers: CustomersService,
    private readonly notas: NotaFiscalVentaService,
    private readonly caja: CajaService,
    private readonly ledgerPosting: LedgerPostingService,
    @Optional()
    @InjectModel(FinanceReceivable.name)
    private readonly receivables?: Model<FinanceReceivableDocument>,
    /** Saldo a favor por cliente (Fase 6C). */
    @Optional()
    private readonly saldoFavor?: SaldoFavorService,
  ) {}

  async list(sedeId: string, user: JwtUser): Promise<NotaSinReferenciaDocument[]> {
    assertSedeAccess(user, sedeId);
    return this.model
      .find({ sedeId: new Types.ObjectId(sedeId) })
      .sort({ createdAt: -1 })
      .limit(200)
      .exec();
  }

  async create(dto: CreateNotaSinReferenciaDto, user: JwtUser): Promise<NotaSinReferenciaDocument> {
    assertSedeAccess(user, dto.sedeId);
    const llave = dto.idempotencyKey.trim();
    const previa = await this.model.findOne({ idempotencyKey: llave }).exec();
    if (previa) return this.reanudar(previa, dto, user);

    const cliente = await this.customers.getOrFail(dto.customerId);
    const docNumber = cliente.docNumber?.trim();
    if (!docNumber) throw new BadRequestException('El cliente no tiene documento de identificación.');

    let registro: NotaSinReferenciaDocument;
    try {
      registro = await this.model.create({
        sedeId: new Types.ObjectId(dto.sedeId),
        customerId: cliente._id,
        customerName: cliente.name,
        docNumber,
        concepto: dto.concepto,
        desde: dto.desde,
        hasta: dto.hasta,
        amount: cop(dto.amount),
        refundMethod: dto.refundMethod,
        reason: dto.reason.trim(),
        idempotencyKey: llave,
        estado: 'en_curso',
        procesandoHasta: new Date(Date.now() + NotasSinReferenciaService.TURNO_MS),
        userId: user.userId,
        userEmail: user.email,
      });
    } catch (err) {
      if ((err as { code?: number })?.code === 11000) {
        const ganadora = await this.model.findOne({ idempotencyKey: llave }).exec();
        if (ganadora) return this.reanudar(ganadora, dto, user);
      }
      throw err;
    }

    let abono = 0;
    let nota: NotaSinReferenciaEmitida;
    try {
      abono = await this.abonarCartera(registro, user);
      nota = await this.emitirNota(registro, user);
    } catch (err) {
      // Sin nota no se mueve nada: se deshace el abono y se retira el registro.
      if (abono > 0) await this.revertirCartera(registro);
      await this.model.deleteOne({ _id: registro._id }).exec();
      throw err;
    }
    registro.abonoCartera = abono;
    registro.carteraHecha = true;
    return this.terminar(registro, nota, user, 'caja');
  }

  private async emitirNota(registro: NotaSinReferenciaDocument, user: JwtUser): Promise<NotaSinReferenciaEmitida> {
    const nota = await this.notas.emitirSinReferencia(
      {
        origen: origenNotaSinReferencia(registro._id.toString()),
        sedeId: registro.sedeId.toString(),
        docNumber: registro.docNumber,
        concepto: registro.concepto,
        motivo: `${registro.reason} (${registro.desde} a ${registro.hasta})`,
        desde: registro.desde,
        hasta: registro.hasta,
        monto: registro.amount,
      },
      user,
    );
    if (cop(nota.total) !== registro.amount || nota.iva + nota.inc > nota.total) {
      // La nota y la operación tienen que decir lo mismo: si no, no se sigue.
      throw new ConflictException('La nota emitida no corresponde al descuento pedido. Revísalo con soporte.');
    }
    return nota;
  }

  /**
   * Abona la cartera viva del cliente (sus CxC abiertas, de la más vieja a
   * la más nueva) hasta el monto de la nota. Update condicionado a lo leído,
   * como el abono de la devolución; idempotente por operación. Devuelve lo
   * que bajó la cartera.
   */
  private async abonarCartera(registro: NotaSinReferenciaDocument, user: JwtUser): Promise<number> {
    if (!this.receivables) return 0;
    const llave = llaveCartera(registro._id.toString());
    const ya = await this.receivables.find({ customerId: registro.customerId, 'ajustes.returnId': llave }).exec();
    if (ya.length > 0) {
      return ya.reduce(
        (t, c) => t + (c.ajustes ?? []).filter((a) => a.returnId === llave).reduce((s, a) => s + a.amount, 0),
        0,
      );
    }
    let falta = registro.amount;
    let abonado = 0;
    const abiertas = await this.receivables
      .find({ customerId: registro.customerId, status: { $in: ['open', 'partial'] } })
      .sort({ dueDate: 1, issueDate: 1 })
      .exec();
    for (const cxc of abiertas) {
      if (falta <= 0) break;
      const abono = Math.min(falta, clampNonNegative(cxc.amount - cxc.paidAmount));
      if (abono <= 0) continue;
      const nuevo = cxc.amount - abono;
      const status = cxc.paidAmount >= nuevo ? 'paid' : cxc.paidAmount > 0 ? 'partial' : 'open';
      const hecho = await this.receivables
        .findOneAndUpdate(
          { _id: cxc._id, amount: cxc.amount, paidAmount: cxc.paidAmount, status: { $ne: 'void' } },
          {
            $inc: { amount: -abono },
            $push: {
              ajustes: {
                date: fechaColombia(),
                amount: abono,
                returnId: llave,
                motivo: `Descuento sin referencia (${registro.desde} a ${registro.hasta})`,
                userEmail: user.email,
              },
            },
            $set: { status },
          },
          { new: true },
        )
        .exec();
      if (!hecho) {
        // Un abono que entró a la vez: se deshace lo hecho y el cajero reintenta.
        if (abonado > 0) await this.revertirCartera(registro);
        throw new ConflictException('La cartera del cliente cambió mientras se registraba el descuento. Vuelve a intentarlo.');
      }
      falta -= abono;
      abonado += abono;
    }
    return abonado;
  }

  /** Deshace `abonarCartera` (la nota no se pudo emitir). Nunca lanza. */
  private async revertirCartera(registro: NotaSinReferenciaDocument): Promise<void> {
    if (!this.receivables) return;
    const llave = llaveCartera(registro._id.toString());
    try {
      const cxcs = await this.receivables.find({ 'ajustes.returnId': llave }).exec();
      for (const cxc of cxcs) {
        const abono = (cxc.ajustes ?? []).filter((a) => a.returnId === llave).reduce((s, a) => s + a.amount, 0);
        const r = await this.receivables
          .findOneAndUpdate(
            { _id: cxc._id, 'ajustes.returnId': llave },
            { $inc: { amount: abono }, $pull: { ajustes: { returnId: llave } } },
            { new: true },
          )
          .exec();
        if (r) {
          const status = r.paidAmount >= r.amount ? 'paid' : r.paidAmount > 0 ? 'partial' : 'open';
          await this.receivables.updateOne({ _id: r._id }, { $set: { status } }).exec();
        }
      }
    } catch (err) {
      this.logger.error(
        `CONCILIAR: el descuento ${registro._id.toString()} se retiró pero la cartera no volvió a su valor: ${(err as Error).message}`,
      );
    }
  }

  /** Guarda la nota y completa caja y libro con el turno tomado. */
  private async terminar(
    registro: NotaSinReferenciaDocument,
    nota: NotaSinReferenciaEmitida,
    user: JwtUser,
    modo: 'caja' | 'sin_caja',
  ): Promise<NotaSinReferenciaDocument> {
    const turno = registro.procesandoHasta ?? null;
    try {
      registro.notaFiscal = nota as unknown as Record<string, unknown>;
      registro.iva = cop(nota.iva);
      registro.inc = cop(nota.inc);
      registro.asignaciones = (nota.asignaciones ?? []).map((a) => ({
        saleId: new Types.ObjectId(a.saleId),
        productId: a.productId,
        amount: cop(a.valor),
        tax: cop(a.impuesto),
      }));
      await registro.save();
      await this.completar(registro, user, modo);
    } finally {
      if (turno) {
        await this.model
          .updateOne({ _id: registro._id, procesandoHasta: turno }, { $set: { procesandoHasta: null } })
          .exec()
          .catch(() => undefined);
      }
    }
    this.notas.transmitirDetras(nota, user);
    return registro;
  }

  /**
   * Caja y libro. El efectivo solo sale de la caja con un cajero (`caja`); el
   * barrido (`sin_caja`) nunca la toca y deja la operación `pendiente_caja`.
   */
  private async completar(
    registro: NotaSinReferenciaDocument,
    user: JwtUser,
    modo: 'caja' | 'sin_caja',
  ): Promise<void> {
    const sedeId = registro.sedeId.toString();
    const enPlata = clampNonNegative(registro.amount - (registro.abonoCartera ?? 0));
    if (!registro.cajaHecha) {
      let hecha = true;
      if (registro.refundMethod === 'cash' && enPlata > 0) {
        if (modo === 'sin_caja') {
          hecha = false;
        } else {
          try {
            await this.caja.movement(
              {
                sedeId,
                type: 'out',
                amount: enPlata,
                reason: 'Descuento comercial a cliente',
                note: `Nota sin referencia ${String(registro.notaFiscal?.fullNumber ?? '')}`.trim(),
              } as never,
              user,
            );
          } catch (err) {
            hecha = false;
            this.logger.warn(
              `No se pudo registrar en caja el descuento ${registro._id.toString()}: ${(err as Error).message}`,
            );
          }
        }
      }
      if (hecha) {
        registro.cajaHecha = true;
        await registro.save();
      }
    }
    if (!registro.asientoHecho) {
      // A favor: el excedente sobre la cartera lo gasta en su próxima compra (idempotente).
      if (registro.refundMethod === 'credit_note') {
        await this.saldoFavor?.abonar({
          customerId: registro.customerId,
          customerName: registro.customerName,
          amount: enPlata,
          sourceType: 'nota_sin_referencia',
          sourceId: registro._id.toString(),
          sedeId,
          memo: `Descuento sin referencia (${registro.desde} a ${registro.hasta})`,
        });
      }
      await this.ledgerPosting.postSaleReturn({
        returnId: registro._id.toString(),
        saleNumber: '',
        date: fechaColombia(),
        sedeId,
        refundTotal: registro.amount,
        tax: registro.iva,
        consumptionTax: registro.inc,
        cogs: 0,
        refundMethod: registro.refundMethod,
        // Lo que bajó la cartera viva va contra la 1305, no por el medio.
        toReceivable: registro.abonoCartera ?? 0,
        sourceType: 'nota_sin_referencia',
        memo: `Descuento sin referencia a ${registro.customerName ?? registro.docNumber} (${registro.desde} a ${registro.hasta})`,
        userEmail: registro.userEmail,
      });
      registro.asientoHecho = true;
      await registro.save();
    }
    registro.estado = registro.cajaHecha && registro.asientoHecho ? 'completa' : 'pendiente_caja';
    await registro.save();
  }

  /** Toma el turno de una operación abierta. `null` si otra petición lo tiene. */
  private async tomarTurno(id: Types.ObjectId): Promise<NotaSinReferenciaDocument | null> {
    return this.model
      .findOneAndUpdate(
        {
          _id: id,
          estado: { $ne: 'completa' },
          $or: [{ procesandoHasta: null }, { procesandoHasta: { $lt: new Date() } }],
        },
        { $set: { procesandoHasta: new Date(Date.now() + NotasSinReferenciaService.TURNO_MS) } },
        { new: true },
      )
      .exec();
  }

  /** Lo que falta de una operación con el turno tomado: cartera, nota, caja y libro. */
  private async continuar(
    registro: NotaSinReferenciaDocument,
    user: JwtUser,
    modo: 'caja' | 'sin_caja',
  ): Promise<NotaSinReferenciaDocument> {
    if (!registro.carteraHecha) {
      registro.abonoCartera = await this.abonarCartera(registro, user);
      registro.carteraHecha = true;
      await registro.save();
    }
    // La nota es idempotente por operación: reemitirla devuelve la misma.
    const nota = await this.emitirNota(registro, user);
    return this.terminar(registro, nota, user, modo);
  }

  /**
   * Reintento con la misma llave: otra carga es 409; completa, se devuelve;
   * a medias, se toma el turno y se completa lo que falte.
   */
  private async reanudar(
    previa: NotaSinReferenciaDocument,
    dto: CreateNotaSinReferenciaDto,
    user: JwtUser,
  ): Promise<NotaSinReferenciaDocument> {
    const misma =
      previa.sedeId.toString() === dto.sedeId &&
      previa.customerId.toString() === dto.customerId &&
      previa.concepto === dto.concepto &&
      previa.desde === dto.desde &&
      previa.hasta === dto.hasta &&
      previa.amount === cop(dto.amount) &&
      previa.refundMethod === dto.refundMethod;
    if (!misma) {
      throw new ConflictException('Esa llave ya se usó para otro descuento, con otro cliente, periodo, monto o medio. Usa una llave nueva.');
    }
    if (previa.estado === 'completa') return previa;
    const registro = await this.tomarTurno(previa._id);
    if (!registro) {
      const ahora = await this.model.findById(previa._id).exec();
      if (ahora?.estado === 'completa') return ahora;
      throw new ConflictException('El descuento se está procesando; reintenta en unos segundos.');
    }
    return this.continuar(registro, user, 'caja');
  }

  /**
   * Barrido de varadas (lo llama `DevolucionesVaradasBarrido` dentro del
   * `TenantContext` de cada empresa): termina las `en_curso` de hace más de
   * `VARADA_MS` sin turno vigente, con el usuario que las registró. Nunca toca
   * la caja: lo que solo espera el efectivo queda `pendiente_caja` para el
   * cajero. Las `pendiente_caja` no se barren.
   */
  async completarVaradas(): Promise<{ completadas: number; pendientesCaja: number; fallidas: number }> {
    const limite = new Date(Date.now() - NotasSinReferenciaService.VARADA_MS);
    const varadas = await this.model
      .find({
        estado: 'en_curso',
        createdAt: { $lt: limite },
        $or: [{ procesandoHasta: null }, { procesandoHasta: { $lt: new Date() } }],
      })
      .sort({ createdAt: 1 })
      .limit(100)
      .exec();
    const r = { completadas: 0, pendientesCaja: 0, fallidas: 0 };
    for (const v of varadas) {
      try {
        const registro = await this.tomarTurno(v._id);
        if (!registro) continue;
        const hecho = await this.continuar(registro, usuarioDelRegistro(registro), 'sin_caja');
        if (hecho.estado === 'completa') r.completadas += 1;
        else r.pendientesCaja += 1;
      } catch (err) {
        r.fallidas += 1;
        this.logger.warn(`Descuento sin referencia ${v._id.toString()} sigue en curso: ${(err as Error).message}`);
      }
    }
    return r;
  }
}

/** Quien registró la operación, con acceso solo a su sede (para el barrido). */
function usuarioDelRegistro(r: NotaSinReferenciaDocument): JwtUser {
  return {
    userId: r.userId,
    email: r.userEmail,
    name: r.userEmail,
    role: 'system',
    sedeIds: [r.sedeId.toString()],
    permissions: [],
  } as unknown as JwtUser;
}
