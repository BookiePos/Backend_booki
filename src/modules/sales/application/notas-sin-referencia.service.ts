import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  NotaSinReferencia,
  NotaSinReferenciaDocument,
} from '../infrastructure/schemas/nota-sin-referencia.schema';
import { CreateNotaSinReferenciaDto } from './dto/create-sale-rebate.dto';
import { NotaFiscalVentaService } from './nota-fiscal-venta.service';
import { CajaService } from '../../caja/application/caja.service';
import { CustomersService } from '../../customers/application/customers.service';
import { LedgerPostingService } from '../../core-ledger/application/ledger-posting.service';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { assertSedeAccess } from '../../core-auth/domain/sede-access';
import { fechaColombia } from '../../core-ledger/domain/fecha-contable';
import { origenNotaSinReferencia } from '../domain/documento-fiscal';
import { cop } from '../../finance/domain/money.util';
import type { NotaSinReferenciaEmitida } from './emision-documento-fiscal.puerto';

/**
 * Descuento posterior SIN referencia (Fase 6C): la nota crédito 22 de la FEV
 * que cubre las facturas de un cliente en un periodo, con su salida de plata
 * y su asiento.
 *
 * Mismo orden que la devolución: el registro (con la llave) antes de nada; la
 * nota, que FALLA CERRADO (sin facturas, por encima del tope, sin PIN), antes
 * de mover caja o libro; luego la caja y el asiento, cada uno con su marca
 * para que el reintento con la misma llave complete solo lo que falte.
 *
 * Asiento (`nota_sin_referencia`): Db 4175 por la base, 2408/2495 por el
 * impuesto que reparte la nota; Cr caja, bancos o 2805 según el medio. No hay
 * abono a cartera: la nota no es de una venta, y lo fiado del cliente se
 * abona aparte (o se elige saldo a favor).
 */
@Injectable()
export class NotasSinReferenciaService {
  private readonly logger = new Logger(NotasSinReferenciaService.name);
  static readonly TURNO_MS = 5 * 60 * 1000;

  constructor(
    @InjectModel(NotaSinReferencia.name)
    private readonly model: Model<NotaSinReferenciaDocument>,
    private readonly customers: CustomersService,
    private readonly notas: NotaFiscalVentaService,
    private readonly caja: CajaService,
    private readonly ledgerPosting: LedgerPostingService,
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

    let nota: NotaSinReferenciaEmitida;
    try {
      nota = await this.emitirNota(registro, user);
    } catch (err) {
      // Sin nota no se mueve nada: la operación se retira entera.
      await this.model.deleteOne({ _id: registro._id }).exec();
      throw err;
    }
    return this.terminar(registro, nota, user);
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

  /** Guarda la nota y completa caja y libro con el turno tomado. */
  private async terminar(
    registro: NotaSinReferenciaDocument,
    nota: NotaSinReferenciaEmitida,
    user: JwtUser,
  ): Promise<NotaSinReferenciaDocument> {
    const turno = registro.procesandoHasta ?? null;
    try {
      registro.notaFiscal = nota as unknown as Record<string, unknown>;
      registro.iva = cop(nota.iva);
      registro.inc = cop(nota.inc);
      await registro.save();
      await this.completar(registro, user);
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

  private async completar(registro: NotaSinReferenciaDocument, user: JwtUser): Promise<void> {
    const sedeId = registro.sedeId.toString();
    if (!registro.cajaHecha) {
      let hecha = true;
      if (registro.refundMethod === 'cash' && registro.amount > 0) {
        try {
          await this.caja.movement(
            {
              sedeId,
              type: 'out',
              amount: registro.amount,
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
      if (hecha) {
        registro.cajaHecha = true;
        await registro.save();
      }
    }
    if (!registro.asientoHecho) {
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
    const registro = await this.model
      .findOneAndUpdate(
        {
          _id: previa._id,
          estado: { $ne: 'completa' },
          $or: [{ procesandoHasta: null }, { procesandoHasta: { $lt: new Date() } }],
        },
        { $set: { procesandoHasta: new Date(Date.now() + NotasSinReferenciaService.TURNO_MS) } },
        { new: true },
      )
      .exec();
    if (!registro) {
      const ahora = await this.model.findById(previa._id).exec();
      if (ahora?.estado === 'completa') return ahora;
      throw new ConflictException('El descuento se está procesando; reintenta en unos segundos.');
    }
    // La nota es idempotente por operación: reemitirla devuelve la misma.
    const nota = await this.emitirNota(registro, user);
    return this.terminar(registro, nota, user);
  }
}
