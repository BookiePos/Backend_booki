import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Sale } from '../../sales/infrastructure/schemas/sale.schema';
import {
  DELIVERY_STATUS_LABELS,
  DeliveryStatus,
  canTransition,
} from '../domain/delivery.constants';
import { UpdateDeliveryStatusDto } from './dto/delivery-status.dto';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { assertSedeAccess } from '../../core-auth/domain/sede-access';
import { cop } from '../../finance/domain/money.util';

/** Un domicilio en la lista del día. */
export interface DeliveryRow {
  saleId: string;
  saleNumber: string;
  createdAt: string;
  status: DeliveryStatus;
  address: string;
  phone?: string;
  notes?: string;
  courier?: string;
  zoneName?: string;
  fee: number;
  /** Total de la venta sin el domicilio. */
  total: number;
  /** Lo que el cliente pagó en total. */
  grandTotal: number;
  paymentMethod: string;
  dispatchedAt?: string;
  deliveredAt?: string;
  failureReason?: string;
}

/** Lo que un repartidor tiene que entregar al volver. */
export interface CourierSettlement {
  courier: string;
  entregados: number;
  enCamino: number;
  fallidos: number;
  /** Efectivo que recogió y tiene que devolver a la caja. */
  efectivoRecaudado: number;
  /** Lo que se cobró por llevarlos, para liquidarle si va por domicilio. */
  domiciliosCobrados: number;
}

/**
 * Seguimiento de domicilios y cuadre por repartidor.
 *
 * La venta ya ocurrió y la plata ya entró: esto es logística. Por eso el estado
 * vive dentro de la venta pero no la toca — un domicilio que se cae se resuelve
 * con una devolución, no cambiándole el estado a la venta.
 *
 * Lo que de verdad se juega es el cuadre del final del turno: el repartidor
 * salió con cinco pedidos, cobró tres en efectivo, y alguien tiene que saber
 * cuánta plata trae en el bolsillo antes de que se vaya.
 */
@Injectable()
export class DeliveriesService {
  constructor(
    @InjectModel(Sale.name)
    private readonly saleModel: Model<Sale>,
  ) {}

  private rangoDelDia(date?: string): { $gte: Date; $lte: Date } {
    const base = date ? new Date(`${date}T00:00:00`) : new Date();
    const desde = new Date(base);
    desde.setHours(0, 0, 0, 0);
    const hasta = new Date(base);
    hasta.setHours(23, 59, 59, 999);
    return { $gte: desde, $lte: hasta };
  }

  /**
   * Domicilios de una sede en un día.
   *
   * Por día y no "todos los pendientes" a propósito: un domicilio que quedó en
   * "en camino" de hace tres semanas es un dato viejo que nadie va a resolver,
   * y tenerlo arriba de la lista esconde los de hoy, que son los que importan.
   */
  async list(
    query: { sedeId: string; date?: string; status?: DeliveryStatus },
    user: JwtUser,
  ): Promise<DeliveryRow[]> {
    assertSedeAccess(user, query.sedeId);

    const filtro: Record<string, unknown> = {
      sedeId: new Types.ObjectId(query.sedeId),
      orderType: 'domicilio',
      status: { $ne: 'void' },
      createdAt: this.rangoDelDia(query.date),
    };
    if (query.status) filtro['delivery.status'] = query.status;

    const ventas = await this.saleModel
      .find(filtro)
      .sort({ createdAt: 1 })
      .limit(500)
      .exec();

    return ventas.flatMap((v) => {
      const d = v.delivery;
      if (!d) return [];
      const doc = v as unknown as { _id: Types.ObjectId; createdAt?: Date };
      return [
        {
          saleId: doc._id.toString(),
          saleNumber: v.saleNumber,
          createdAt: (doc.createdAt ?? new Date()).toISOString(),
          status: d.status ?? 'pendiente',
          address: d.address,
          phone: d.phone,
          notes: d.notes,
          courier: d.courier,
          zoneName: d.zoneName,
          fee: v.deliveryFee ?? 0,
          total: v.total,
          grandTotal: cop(v.total + (v.tip ?? 0) + (v.deliveryFee ?? 0)),
          paymentMethod: v.payment?.method ?? 'cash',
          dispatchedAt: d.dispatchedAt?.toISOString(),
          deliveredAt: d.deliveredAt?.toISOString(),
          failureReason: d.failureReason,
        },
      ];
    });
  }

  /**
   * Mueve el estado de una entrega.
   *
   * Los pasos hacia atrás están cerrados (ver `DELIVERY_TRANSITIONS`): un
   * domicilio entregado no vuelve a "en camino", porque si de verdad volvió eso
   * es una devolución y no un paso atrás de la logística. Dejarlo ir hacia
   * atrás convertiría el cuadre del repartidor en algo que nadie puede
   * auditar.
   */
  async updateStatus(
    saleId: string,
    dto: UpdateDeliveryStatusDto,
    user: JwtUser,
  ) {
    if (!Types.ObjectId.isValid(saleId)) {
      throw new NotFoundException('Venta no encontrada');
    }
    const venta = await this.saleModel.findById(saleId).exec();
    if (!venta) throw new NotFoundException('Venta no encontrada');
    assertSedeAccess(user, venta.sedeId.toString());

    if (venta.orderType !== 'domicilio' || !venta.delivery) {
      throw new BadRequestException('Esta venta no es un domicilio');
    }

    const actual = venta.delivery.status ?? 'pendiente';
    if (!canTransition(actual, dto.status)) {
      throw new BadRequestException(
        `Un domicilio ${DELIVERY_STATUS_LABELS[actual].toLowerCase()} no puede pasar a ${DELIVERY_STATUS_LABELS[dto.status].toLowerCase()}`,
      );
    }

    if (dto.status === 'fallido' && !dto.failureReason?.trim()) {
      // Sin motivo, un domicilio fallido es un dato que no sirve para nada:
      // nadie puede saber si fue la dirección, el cliente o el repartidor.
      throw new BadRequestException(
        'Di por qué no se pudo entregar: sin el motivo no hay nada que corregir',
      );
    }

    venta.delivery.status = dto.status;
    if (dto.courier !== undefined) {
      venta.delivery.courier = dto.courier.trim() || undefined;
    }
    if (dto.status === 'en_camino' && !venta.delivery.dispatchedAt) {
      venta.delivery.dispatchedAt = new Date();
    }
    if (dto.status === 'entregado') {
      venta.delivery.deliveredAt = new Date();
      // Marcar entregado sin haber pasado por "en camino" es lo normal cuando
      // el repartidor vuelve y registra todo de una: la hora de salida se
      // completa para que el tiempo de entrega no quede vacío.
      if (!venta.delivery.dispatchedAt) {
        venta.delivery.dispatchedAt = new Date();
      }
      venta.delivery.failureReason = undefined;
    }
    if (dto.status === 'fallido') {
      venta.delivery.failureReason = dto.failureReason?.trim();
      venta.delivery.deliveredAt = undefined;
    }

    venta.markModified('delivery');
    await venta.save();
    return venta;
  }

  /**
   * Cuadre del turno por repartidor.
   *
   * Es la pregunta del final del día: el repartidor salió con cinco pedidos,
   * ¿cuánta plata trae? Solo cuenta el EFECTIVO de lo que alcanzó a entregar —
   * lo que se pagó con tarjeta o transferencia nunca pasó por sus manos, y lo
   * que no entregó todavía no lo cobró.
   */
  async settlement(
    query: { sedeId: string; date?: string },
    user: JwtUser,
  ): Promise<CourierSettlement[]> {
    const filas = await this.list({ sedeId: query.sedeId, date: query.date }, user);

    const porRepartidor = new Map<string, CourierSettlement>();
    for (const f of filas) {
      // Sin repartidor asignado se agrupan aparte: son los que alguien tiene
      // que reclamar antes de cerrar.
      const clave = f.courier?.trim() || 'Sin asignar';
      const acc =
        porRepartidor.get(clave) ??
        ({
          courier: clave,
          entregados: 0,
          enCamino: 0,
          fallidos: 0,
          efectivoRecaudado: 0,
          domiciliosCobrados: 0,
        } satisfies CourierSettlement);

      if (f.status === 'entregado') {
        acc.entregados += 1;
        if (f.paymentMethod === 'cash') acc.efectivoRecaudado += f.grandTotal;
        acc.domiciliosCobrados += f.fee;
      } else if (f.status === 'en_camino') {
        acc.enCamino += 1;
      } else if (f.status === 'fallido') {
        acc.fallidos += 1;
      }
      porRepartidor.set(clave, acc);
    }

    return [...porRepartidor.values()].sort(
      (a, b) => b.efectivoRecaudado - a.efectivoRecaudado,
    );
  }
}
