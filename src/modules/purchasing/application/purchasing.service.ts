import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  PurchaseOrder,
  PurchaseOrderDocument,
} from '../infrastructure/schemas/purchase-order.schema';
import {
  FinancePayable,
  FinancePayableDocument,
} from '../../finance/infrastructure/schemas/finance-payable.schema';
import { StockService } from '../../inventory/application/stock.service';
import { TaxService } from '../../core-tax/application/tax.service';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import {
  allowedSedeIds,
  assertSedeAccess,
} from '../../core-auth/domain/sede-access';
import { PurchaseOrderStatus } from '../domain/purchasing.constants';
import {
  CreatePurchaseOrderDto,
  PurchaseLineDto,
  ReceivePurchaseOrderDto,
  UpdatePurchaseOrderDto,
} from './dto/purchasing.dto';

@Injectable()
export class PurchasingService {
  constructor(
    @InjectModel(PurchaseOrder.name)
    private readonly orders: Model<PurchaseOrderDocument>,
    @InjectModel(FinancePayable.name)
    private readonly payables: Model<FinancePayableDocument>,
    private readonly stock: StockService,
    private readonly tax: TaxService,
  ) {}

  private async nextNumber(): Promise<string> {
    const n = (await this.orders.estimatedDocumentCount().exec()) + 1;
    return `OC-${String(n).padStart(6, '0')}`;
  }

  /** Calcula subtotal e impuesto de cada renglón (tarifa vigente del código). */
  private async buildLines(dtoLines: PurchaseLineDto[]) {
    const lines = [];
    let subtotal = 0;
    let taxAmount = 0;
    for (const l of dtoLines) {
      const lineSub = Math.round(l.unitCost * l.qty);
      let lineTax = 0;
      if (l.taxCode) {
        const computed = await this.tax.compute(l.taxCode, lineSub);
        lineTax = computed.taxAmount;
      }
      subtotal += lineSub;
      taxAmount += lineTax;
      lines.push({
        productId: l.productId ? new Types.ObjectId(l.productId) : undefined,
        description: l.description,
        qty: l.qty,
        qtyReceived: 0,
        unitCost: l.unitCost,
        taxCode: l.taxCode,
        subtotal: lineSub,
        taxAmount: lineTax,
      });
    }
    return { lines, subtotal, taxAmount, total: subtotal + taxAmount };
  }

  async create(
    dto: CreatePurchaseOrderDto,
    user: JwtUser,
  ): Promise<PurchaseOrderDocument> {
    assertSedeAccess(user, dto.sedeId);
    const { lines, subtotal, taxAmount, total } = await this.buildLines(
      dto.lines,
    );
    return this.orders.create({
      number: await this.nextNumber(),
      sedeId: new Types.ObjectId(dto.sedeId),
      supplierId: dto.supplierId
        ? new Types.ObjectId(dto.supplierId)
        : undefined,
      supplierName: dto.supplierName,
      status: dto.send ? 'sent' : 'draft',
      issueDate: dto.issueDate,
      expectedDate: dto.expectedDate,
      lines,
      subtotal,
      taxAmount,
      total,
      note: dto.note,
      createdByEmail: user.email,
    });
  }

  async list(
    user: JwtUser,
    query: { sedeId?: string; status?: PurchaseOrderStatus },
  ): Promise<PurchaseOrderDocument[]> {
    const filter: Record<string, unknown> = {};
    const scope = this.resolveScope(user, query.sedeId);
    if (scope) {
      filter.sedeId = { $in: scope.map((id) => new Types.ObjectId(id)) };
    }
    if (query.status) filter.status = query.status;
    return this.orders.find(filter).sort({ createdAt: -1 }).exec();
  }

  async get(id: string, user: JwtUser): Promise<PurchaseOrderDocument> {
    const po = await this.orders.findById(id).exec();
    if (!po) throw new NotFoundException('Orden de compra no encontrada');
    assertSedeAccess(user, po.sedeId.toString());
    return po;
  }

  async update(
    id: string,
    dto: UpdatePurchaseOrderDto,
    user: JwtUser,
  ): Promise<PurchaseOrderDocument> {
    const po = await this.get(id, user);
    if (po.status !== 'draft') {
      throw new BadRequestException(
        'Solo se puede editar una orden en borrador',
      );
    }
    if (dto.supplierId !== undefined) {
      po.supplierId = new Types.ObjectId(dto.supplierId);
    }
    if (dto.supplierName !== undefined) po.supplierName = dto.supplierName;
    if (dto.expectedDate !== undefined) po.expectedDate = dto.expectedDate;
    if (dto.note !== undefined) po.note = dto.note;
    if (dto.lines) {
      const { lines, subtotal, taxAmount, total } = await this.buildLines(
        dto.lines,
      );
      po.lines = lines as unknown as typeof po.lines;
      po.subtotal = subtotal;
      po.taxAmount = taxAmount;
      po.total = total;
    }
    await po.save();
    return po;
  }

  async send(id: string, user: JwtUser): Promise<PurchaseOrderDocument> {
    const po = await this.get(id, user);
    if (po.status !== 'draft') {
      throw new BadRequestException('La orden ya fue enviada o procesada');
    }
    po.status = 'sent';
    await po.save();
    return po;
  }

  async cancel(id: string, user: JwtUser): Promise<PurchaseOrderDocument> {
    const po = await this.get(id, user);
    if (po.status === 'received' || po.status === 'partial') {
      throw new BadRequestException(
        'No se anula una orden con mercancía ya recibida',
      );
    }
    po.status = 'cancelled';
    await po.save();
    return po;
  }

  /** Recibe (parcial o total): entra a inventario y actualiza el estado. */
  async receive(
    id: string,
    dto: ReceivePurchaseOrderDto,
    user: JwtUser,
  ): Promise<PurchaseOrderDocument> {
    const po = await this.get(id, user);
    if (po.status === 'cancelled' || po.status === 'received') {
      throw new BadRequestException(
        `No se puede recibir una orden ${po.status === 'received' ? 'ya recibida' : 'anulada'}`,
      );
    }

    let receivedValue = 0;
    for (const rl of dto.lines) {
      const line = po.lines[rl.lineIndex];
      if (!line) {
        throw new BadRequestException(
          `Renglón ${rl.lineIndex} inexistente en la orden`,
        );
      }
      const remaining = line.qty - line.qtyReceived;
      if (rl.qty > remaining) {
        throw new BadRequestException(
          `El renglón "${line.description}" solo tiene ${remaining} pendiente(s) por recibir`,
        );
      }
      // Entra al inventario únicamente si el renglón está mapeado a un producto.
      if (line.productId) {
        await this.stock.entry(
          {
            productId: line.productId.toString(),
            sedeId: po.sedeId.toString(),
            qty: rl.qty,
            unitCost: line.unitCost,
            lotCode: rl.lotCode,
            supplier: po.supplierName,
            supplierId: po.supplierId?.toString(),
            expiresAt: rl.expiresAt,
            note: `Recepción ${po.number}`,
          },
          user,
        );
      }
      line.qtyReceived += rl.qty;
      receivedValue += Math.round(line.unitCost * rl.qty);
    }

    // Genera CxP por el valor recibido, si se pidió.
    let payableId: Types.ObjectId | undefined;
    if (dto.generatePayable && receivedValue > 0) {
      const dueDate = dto.dueDate ?? this.addDays(dto.date, 30);
      const [payable] = await this.payables.create([
        {
          sedeId: po.sedeId,
          supplierId: po.supplierId,
          supplierName: po.supplierName,
          docNumber: dto.docNumber ?? po.number,
          issueDate: dto.date,
          dueDate,
          amount: receivedValue,
          paidAmount: 0,
          status: 'open',
          payments: [],
          note: `Compra ${po.number}`,
          createdByEmail: user.email,
        },
      ]);
      payableId = payable?._id;
    }

    po.receipts.push({
      date: dto.date,
      lines: dto.lines.map((l) => ({
        lineIndex: l.lineIndex,
        qty: l.qty,
        lotCode: l.lotCode,
        expiresAt: l.expiresAt,
      })),
      note: dto.note,
      userEmail: user.email,
      payableId,
    } as unknown as (typeof po.receipts)[number]);

    po.status = this.computeStatus(po);
    await po.save();
    return po;
  }

  private computeStatus(po: PurchaseOrderDocument): PurchaseOrderStatus {
    const fullyReceived = po.lines.every((l) => l.qtyReceived >= l.qty);
    if (fullyReceived) return 'received';
    const anyReceived = po.lines.some((l) => l.qtyReceived > 0);
    return anyReceived ? 'partial' : po.status;
  }

  private addDays(date: string, days: number): string {
    const d = new Date(`${date}T00:00:00`);
    d.setDate(d.getDate() + days);
    return d.toLocaleDateString('en-CA');
  }

  private resolveScope(user: JwtUser, sedeId?: string): string[] | null {
    if (sedeId) {
      assertSedeAccess(user, sedeId);
      return [sedeId];
    }
    return allowedSedeIds(user);
  }
}
