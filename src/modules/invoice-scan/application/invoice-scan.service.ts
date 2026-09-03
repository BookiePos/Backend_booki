import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { randomBytes } from 'crypto';
import { BlobStorageService } from '../../../shared/storage/blob-storage.service';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import { BusinessService } from '../../control/application/business.service';
import { ProductsService } from '../../inventory/application/products.service';
import { SuppliersService } from '../../suppliers/application/suppliers.service';
import { PurchasingService } from '../../purchasing/application/purchasing.service';
import { FinanceService } from '../../finance/application/finance.service';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { cop } from '../../finance/domain/money.util';
import {
  InvoiceScan,
  InvoiceScanDocument,
  NewProductDraft,
} from '../infrastructure/schemas/invoice-scan.schema';
import {
  INVOICE_IMAGE_MAX_BYTES,
  INVOICE_IMAGE_TYPES_LABEL,
  InvoiceScanStatus,
  ScanAction,
  invoiceImageExtension,
  taxCodeForRate,
} from '../domain/invoice-scan.constants';
import {
  ExtractedInvoice,
  ExtractedLine,
  emptyInvoice,
} from '../domain/invoice-extraction';
import { qtyFitsPurchaseLine } from '../domain/line-classification';
import { INVOICE_EXTRACTOR, InvoiceExtractor } from './invoice-extractor';
import { InvoiceMatchingService } from './invoice-matching.service';
import { UpdateInvoiceScanDto } from './dto/invoice-scan.dto';

/** Archivo subido. Se declara aquí para no añadir `@types/multer` al proyecto. */
export interface UploadedInvoiceImage {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname?: string;
}

@Injectable()
export class InvoiceScanService {
  private readonly logger = new Logger('InvoiceScanService');

  constructor(
    @InjectModel(InvoiceScan.name)
    private readonly scans: Model<InvoiceScanDocument>,
    @Inject(INVOICE_EXTRACTOR)
    private readonly extractor: InvoiceExtractor,
    private readonly matching: InvoiceMatchingService,
    private readonly storage: BlobStorageService,
    private readonly businesses: BusinessService,
    private readonly suppliers: SuppliersService,
    private readonly products: ProductsService,
    private readonly purchasing: PurchasingService,
    private readonly finance: FinanceService,
  ) {}

  // ─── Subida ───────────────────────────────────────────────────────────────

  /**
   * Guarda la foto y crea la factura en estado `uploaded`.
   *
   * La cuota se consume aquí y no al extraer porque es la subida la que ya
   * comprometió almacenamiento; y así un reintento de lectura fallida no vuelve
   * a cobrar. Por lo mismo se comprueba antes que el store esté configurado:
   * cobrar un escaneo que nunca se llegó a guardar sería peor que no cobrarlo.
   */
  async upload(
    file: UploadedInvoiceImage,
    user: JwtUser,
    /** Texto del PDF, si el navegador lo pudo extraer. */
    text?: string,
  ): Promise<InvoiceScanDocument> {
    const extension = invoiceImageExtension(file.mimetype);
    if (!extension) {
      throw new BadRequestException(
        `Formato no admitido. Usa ${INVOICE_IMAGE_TYPES_LABEL}.`,
      );
    }
    if (file.size > INVOICE_IMAGE_MAX_BYTES) {
      throw new BadRequestException(
        `La imagen supera los ${Math.round(INVOICE_IMAGE_MAX_BYTES / 1024 / 1024)} MB.`,
      );
    }

    // Antes de cobrar: si no hay almacenamiento la subida va a fallar igual, y
    // un 503 de configuración no debe costarle un escaneo al negocio.
    this.storage.assertAvailable();

    const ctx = TenantContext.currentOrThrow();
    await this.businesses.consumeScan(ctx.businessId, ctx.plan);

    const pathname = `facturas/${ctx.businessId}/${Date.now()}-${randomBytes(6).toString('hex')}.${extension}`;
    const stored = await this.storage.upload(pathname, file.buffer, file.mimetype);

    const conTexto = Boolean(text && text.trim().length > 0);
    const scan = await this.scans.create({
      pages: [
        {
          imageUrl: stored.url,
          imagePathname: stored.pathname,
          text: conTexto ? text : undefined,
        },
      ],
      status: 'uploaded',
      createdByEmail: user.email,
      history: [
        {
          at: new Date(),
          userEmail: user.email,
          action: 'uploaded',
          detail: conTexto
            ? 'PDF subido con su texto (se leerá sin OCR)'
            : 'Imagen subida',
        },
      ],
    });
    return scan;
  }

  // ─── Lectura ──────────────────────────────────────────────────────────────

  /**
   * Lee la factura con el modelo y deja el borrador listo para revisar.
   *
   * La imagen se vuelve a descargar del store en vez de conservarse en memoria
   * entre peticiones: así reintentar una lectura fallida no obliga a volver a
   * fotografiar, que es justo lo que pasa cuando el modelo se atraganta.
   */
  async extract(id: string, user: JwtUser): Promise<InvoiceScanDocument> {
    const scan = await this.getOrFail(id);
    if (scan.status === 'applied') {
      throw new BadRequestException('Esta factura ya se aplicó');
    }
    const page = scan.pages[0];
    if (!page) throw new BadRequestException('La factura no tiene imagen');

    try {
      // Con texto del PDF no se usa visión: los caracteres ya son exactos y
      // reconocerlos otra vez solo puede introducir errores en los precios.
      const result = page.text
        ? await this.extractor.extractText(page.text)
        : await this.extractor.extract(
            ...(await this.downloadArgs(page.imageUrl)),
          );

      page.raw = result.raw;
      page.model = result.model;
      page.extractedAt = new Date();
      scan.draft = result.parsed;
      scan.status = 'extracted';
      scan.error = undefined;
      await this.hydrateMatches(scan, result.parsed);
      this.addHistory(
        scan,
        user,
        'extracted',
        `Leída ${page.text ? 'del texto del PDF' : 'por OCR'} con ${result.model} en ${result.ms} ms`,
      );
      await scan.save();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      scan.status = 'failed';
      scan.error = message;
      this.addHistory(scan, user, 'failed', message);
      await scan.save();
      throw err;
    }

    // Agrupación: si esta imagen es otra página de una factura ya leída, se
    // fusiona y se devuelve aquella.
    const sibling = await this.findSibling(scan);
    if (sibling) return this.mergeInto(sibling, scan, user);
    return scan;
  }

  /** Rellena proveedor y decisiones por línea con lo que se pudo emparejar. */
  private async hydrateMatches(
    scan: InvoiceScanDocument,
    draft: ExtractedInvoice,
  ): Promise<void> {
    const supplier = await this.matching.matchSupplier(draft);
    scan.supplierMatch = supplier.mode;
    scan.supplierId = supplier.supplierId
      ? new Types.ObjectId(supplier.supplierId)
      : undefined;
    scan.supplierDocNumber = draft.supplier.docNumber;
    scan.invoiceNumber = draft.invoice.number;

    const matches = await this.matching.matchLines(draft.lines, supplier.supplierId);
    scan.lineDecisions = matches.map((m) => ({
      lineIndex: m.lineIndex,
      target: m.target,
      productId: m.productId ? new Types.ObjectId(m.productId) : undefined,
      createProduct: m.createProduct,
      categoryId: undefined,
      matchedBy: m.matchedBy,
    }));
  }

  // ─── Agrupación de páginas ────────────────────────────────────────────────

  /**
   * Otra página de la misma factura: mismo NIT y mismo número, sin aplicar.
   *
   * Sin número de factura no se puede decidir (dos remisiones del mismo
   * proveedor el mismo día se fusionarían mal), así que en ese caso se deja
   * aparte y la persona une a mano desde la interfaz.
   */
  private async findSibling(
    scan: InvoiceScanDocument,
  ): Promise<InvoiceScanDocument | null> {
    if (!scan.supplierDocNumber || !scan.invoiceNumber) return null;
    return this.scans
      .findOne({
        _id: { $ne: scan._id },
        supplierDocNumber: scan.supplierDocNumber,
        invoiceNumber: scan.invoiceNumber,
        status: { $in: ['uploaded', 'extracted', 'failed'] },
      })
      .sort({ createdAt: 1 })
      .exec();
  }

  /** Une `source` a `target` como página adicional y borra el sobrante. */
  private async mergeInto(
    target: InvoiceScanDocument,
    source: InvoiceScanDocument,
    user: JwtUser,
  ): Promise<InvoiceScanDocument> {
    const targetDraft = (target.draft as ExtractedInvoice) ?? emptyInvoice();
    const sourceDraft = (source.draft as ExtractedInvoice) ?? emptyInvoice();

    target.pages.push(...source.pages);
    // Las líneas se concatenan; la cabecera y los totales se quedan con los de
    // la primera página, que es donde vienen impresos.
    targetDraft.lines = [...targetDraft.lines, ...sourceDraft.lines];
    target.draft = targetDraft;
    target.markModified('draft');
    await this.hydrateMatches(target, targetDraft);
    this.addHistory(
      target,
      user,
      'merged',
      `Se añadió una página (${sourceDraft.lines.length} líneas más)`,
    );
    await target.save();

    await source.deleteOne();
    return target;
  }

  /** Une a mano dos facturas que la agrupación automática no pudo relacionar. */
  async merge(id: string, sourceId: string, user: JwtUser): Promise<InvoiceScanDocument> {
    const target = await this.getOrFail(id);
    const source = await this.getOrFail(sourceId);
    if (target.status === 'applied' || source.status === 'applied') {
      throw new BadRequestException('No se puede unir una factura ya aplicada');
    }
    return this.mergeInto(target, source, user);
  }

  /** Separa una página en una factura aparte (deshace una unión equivocada). */
  async split(
    id: string,
    pageIndex: number,
    user: JwtUser,
  ): Promise<InvoiceScanDocument> {
    const scan = await this.getOrFail(id);
    if (scan.status === 'applied') {
      throw new BadRequestException('No se puede separar una factura ya aplicada');
    }
    const page = scan.pages[pageIndex];
    if (!page) throw new BadRequestException('Esa página no existe');
    if (scan.pages.length < 2) {
      throw new BadRequestException('La factura tiene una sola página');
    }

    scan.pages.splice(pageIndex, 1);
    this.addHistory(scan, user, 'split', `Se separó la página ${pageIndex + 1}`);
    await scan.save();

    return this.scans.create({
      pages: [page],
      status: 'uploaded',
      createdByEmail: user.email,
      history: [
        {
          at: new Date(),
          userEmail: user.email,
          action: 'split',
          detail: 'Separada de otra factura',
        },
      ],
    });
  }

  // ─── Edición del borrador ─────────────────────────────────────────────────

  /**
   * Guarda las correcciones de la persona.
   *
   * Cada cambio queda en el historial con su valor anterior: si mañana el
   * inventario no cuadra, se puede ver qué se cambió a mano y qué venía del
   * modelo.
   */
  async update(
    id: string,
    dto: UpdateInvoiceScanDto,
    user: JwtUser,
  ): Promise<InvoiceScanDocument> {
    const scan = await this.getOrFail(id);
    if (scan.status === 'applied') {
      throw new BadRequestException('Esta factura ya se aplicó');
    }

    if (dto.draft) {
      scan.draft = dto.draft as unknown as ExtractedInvoice;
      scan.markModified('draft');
      const draft = dto.draft as unknown as ExtractedInvoice;
      scan.supplierDocNumber = draft.supplier?.docNumber;
      scan.invoiceNumber = draft.invoice?.number;
      this.addHistory(scan, user, 'edited', 'Se editaron los datos de la factura');
    }
    if (dto.supplierId !== undefined) {
      const previous = scan.supplierId?.toString();
      scan.supplierId = dto.supplierId
        ? new Types.ObjectId(dto.supplierId)
        : undefined;
      scan.supplierMatch = dto.supplierId ? 'manual' : 'unknown';
      if (previous !== dto.supplierId) {
        this.addHistory(scan, user, 'edited', 'Se cambió el proveedor');
      }
    }
    if (dto.sedeId !== undefined) {
      scan.sedeId = dto.sedeId ? new Types.ObjectId(dto.sedeId) : undefined;
      this.addHistory(scan, user, 'edited', 'Se cambió la sede de destino');
    }
    if (dto.lineDecisions) {
      scan.lineDecisions = dto.lineDecisions.map((d) => ({
        lineIndex: d.lineIndex,
        target: d.target,
        productId: d.productId ? new Types.ObjectId(d.productId) : undefined,
        createProduct: d.createProduct ?? false,
        categoryId: d.categoryId ? new Types.ObjectId(d.categoryId) : undefined,
        newProduct: d.newProduct
          ? {
              ...d.newProduct,
              categoryId: d.newProduct.categoryId
                ? new Types.ObjectId(d.newProduct.categoryId)
                : undefined,
            }
          : undefined,
        matchedBy: 'manual',
      }));
      this.addHistory(scan, user, 'edited', 'Se ajustó el destino de las líneas');
    }
    scan.status = scan.status === 'failed' ? 'extracted' : scan.status;
    await scan.save();
    return scan;
  }

  // ─── Aplicación ───────────────────────────────────────────────────────────

  /**
   * Lleva la factura aprobada al sistema.
   *
   * El orden es proveedor → productos → compra → gastos, y **cada paso se
   * guarda antes del siguiente**. No hay transacción global (cada servicio trae
   * la suya), así que la garantía real es que un reintento no duplica: lo ya
   * hecho queda anotado en `appliedTo` y se salta.
   */
  async apply(id: string, user: JwtUser): Promise<InvoiceScanDocument> {
    const scan = await this.getOrFail(id);
    if (scan.status === 'applied') return scan;

    const draft = (scan.draft as ExtractedInvoice) ?? emptyInvoice();
    const plan = this.planApplication(scan, draft);

    // 1. Proveedor.
    if (!scan.appliedTo.supplierId) {
      const supplierId = await this.resolveSupplier(scan, draft);
      scan.appliedTo.supplierId = new Types.ObjectId(supplierId);
      scan.supplierId = scan.appliedTo.supplierId;
      await scan.save();
    }
    const supplierId = scan.appliedTo.supplierId.toString();
    const supplierName =
      draft.supplier.name ?? (await this.suppliers.getOrFail(supplierId)).name;

    // 2. Productos que no existían. Se crean con lo que la persona completó en
    //    la ficha de la revisión; lo que no tocó, con lo que dijo la factura.
    for (const item of plan.inventory) {
      if (item.productId) continue;
      const nuevo = item.newProduct ?? {};
      const created = await this.products.create({
        sku: item.sku,
        name: nuevo.name || item.line.description,
        unit: nuevo.unit || item.line.unit || 'und',
        categoryId: nuevo.categoryId?.toString(),
        supplierId,
        supplier: supplierName,
        cost: nuevo.cost ?? item.unitCost,
        salePrice: nuevo.salePrice,
        minStock: nuevo.minStock,
        barcode: nuevo.barcode || item.line.barcode,
      });
      item.productId = created.id as string;
      scan.appliedTo.createdProductIds.push(new Types.ObjectId(item.productId));
      const decision = scan.lineDecisions.find((d) => d.lineIndex === item.lineIndex);
      if (decision) {
        decision.productId = new Types.ObjectId(item.productId);
        decision.createProduct = false;
      }
      await scan.save();
    }

    // 3. Compra: orden + recepción. Reusa todo el circuito ya probado (stock,
    //    lotes, kardex, cuenta por pagar y asiento contable).
    if (plan.inventory.length > 0 && !scan.appliedTo.purchaseOrderId) {
      const issueDate = draft.invoice.issueDate ?? todayLocal();
      const order = await this.purchasing.create(
        {
          sedeId: plan.sedeId,
          supplierId,
          supplierName,
          issueDate,
          lines: plan.inventory.map((item) => ({
            productId: item.productId,
            description: item.line.description,
            qty: item.qty,
            unitCost: item.unitCost,
            taxCode: taxCodeForRate(item.line.ivaRate),
          })),
          note: `Factura ${draft.invoice.number ?? 'sin número'} · cargada por foto`,
          send: true,
        },
        user,
      );
      scan.appliedTo.purchaseOrderId = order._id as Types.ObjectId;
      await scan.save();

      await this.purchasing.receive(
        order.id as string,
        {
          date: issueDate,
          lines: plan.inventory.map((item, index) => ({
            lineIndex: index,
            qty: item.qty,
          })),
          generatePayable: draft.invoice.paymentTerms !== 'contado',
          dueDate: draft.invoice.dueDate,
          docNumber: draft.invoice.number,
          note: 'Recepción automática desde factura escaneada',
        },
        user,
      );
    }

    // 4. Gastos (lo que no es mercancía).
    if (plan.expenses.length > 0 && scan.appliedTo.expenseIds.length === 0) {
      for (const item of plan.expenses) {
        const expense = await this.finance.createExpense(
          {
            sedeId: plan.sedeId,
            categoryId: item.categoryId,
            concept: item.line.description,
            amount: item.amount,
            date: draft.invoice.issueDate ?? todayLocal(),
            status: draft.invoice.paymentTerms === 'contado' ? 'paid' : 'payable',
            supplierId,
            supplierName,
            note: `Factura ${draft.invoice.number ?? 'sin número'}`,
          },
          user,
        );
        scan.appliedTo.expenseIds.push(expense._id as Types.ObjectId);
      }
      await scan.save();
    }

    // 5. Aprender los alias para que la próxima factura se empareje sola.
    for (const item of plan.inventory) {
      if (!item.productId) continue;
      await this.matching
        .rememberAlias(supplierId, item.line.description, item.productId)
        .catch(() => undefined);
    }

    scan.status = 'applied';
    this.addHistory(
      scan,
      user,
      'applied',
      `${plan.inventory.length} línea(s) al inventario y ${plan.expenses.length} a gastos`,
    );
    await scan.save();
    return scan;
  }

  /**
   * Valida y arma lo que hay que crear, ANTES de tocar nada.
   *
   * Se hace en un paso aparte para que una factura con un renglón mal quede
   * rechazada entera y con un mensaje concreto, en vez de aplicarse a medias.
   */
  private planApplication(scan: InvoiceScanDocument, draft: ExtractedInvoice) {
    const decisions = new Map(scan.lineDecisions.map((d) => [d.lineIndex, d]));
    const inventory: {
      lineIndex: number;
      line: ExtractedLine;
      qty: number;
      unitCost: number;
      productId?: string;
      sku: string;
      newProduct?: NewProductDraft;
    }[] = [];
    const expenses: { line: ExtractedLine; amount: number; categoryId: string }[] = [];

    draft.lines.forEach((line, lineIndex) => {
      const decision = decisions.get(lineIndex);
      const target = decision?.target ?? 'ignore';
      const label = `"${line.description}"`;

      if (target === 'inventory') {
        if (!qtyFitsPurchaseLine(line.qty)) {
          throw new BadRequestException(
            `La línea ${label} necesita una cantidad entera para entrar al inventario. Ajústala o pásala a gasto.`,
          );
        }
        const unitCost = line.unitCost ?? unitFromTotal(line);
        if (unitCost === undefined) {
          throw new BadRequestException(
            `La línea ${label} no tiene valor unitario. Complétalo antes de aplicar.`,
          );
        }
        const newProduct = decision?.newProduct;
        // Producto nuevo sin SKU: se pide en vez de inventarlo. Un código
        // generado a la brava se queda para siempre en el catálogo y luego hay
        // que adivinar a qué correspondía.
        const sku = (newProduct?.sku || line.code || '').trim().toUpperCase();
        if (!decision?.productId && !sku) {
          throw new BadRequestException(
            `El producto ${label} es nuevo y la factura no trae código. Complétale el SKU antes de aplicar.`,
          );
        }
        inventory.push({
          lineIndex,
          line,
          qty: line.qty as number,
          unitCost: cop(unitCost),
          productId: decision?.productId?.toString(),
          sku,
          newProduct,
        });
        return;
      }

      if (target === 'expense') {
        if (!decision?.categoryId) {
          throw new BadRequestException(
            `Elige la categoría de gasto de la línea ${label}.`,
          );
        }
        const amount = line.lineTotal ?? totalFromUnit(line);
        if (amount === undefined) {
          throw new BadRequestException(
            `La línea ${label} no tiene valor. Complétalo antes de aplicar.`,
          );
        }
        expenses.push({
          line,
          amount: cop(amount),
          categoryId: decision.categoryId.toString(),
        });
      }
    });

    if (inventory.length === 0 && expenses.length === 0) {
      throw new BadRequestException(
        'No hay ninguna línea marcada para inventario ni para gastos.',
      );
    }
    const sedeId = scan.sedeId?.toString();
    if (!sedeId) {
      throw new BadRequestException('Elige la sede a la que entra la factura.');
    }
    if (!scan.supplierId && !draft.supplier.name) {
      throw new BadRequestException(
        'Elige el proveedor o completa su nombre para poder crearlo.',
      );
    }
    return { inventory, expenses, sedeId };
  }

  /** Proveedor existente, o creado con lo leído en la factura. */
  private async resolveSupplier(
    scan: InvoiceScanDocument,
    draft: ExtractedInvoice,
  ): Promise<string> {
    if (scan.supplierId) return scan.supplierId.toString();

    const docNumber = draft.supplier.docNumber;
    const docType = draft.supplier.docType ?? 'NIT';
    if (docNumber) {
      const existing = await this.suppliers.findByDocNumber(docType, docNumber);
      if (existing) return existing.id as string;
    }
    const created = await this.suppliers.create({
      name: draft.supplier.name as string,
      docType,
      // Sin NIT legible se guarda un marcador: el proveedor se crea igual (para
      // no bloquear la carga) y queda evidente que hay que completarlo.
      docNumber: docNumber ?? `SIN-NIT-${Date.now()}`,
      phone: draft.supplier.phone,
      address: draft.supplier.address,
      city: draft.supplier.city,
    });
    return created.id as string;
  }

  // ─── Consulta y descarte ──────────────────────────────────────────────────

  list(status?: InvoiceScanStatus): Promise<InvoiceScanDocument[]> {
    return this.scans
      .find(status ? { status } : {})
      .sort({ createdAt: -1 })
      .limit(200)
      .exec();
  }

  async getOrFail(id: string): Promise<InvoiceScanDocument> {
    const scan = Types.ObjectId.isValid(id)
      ? await this.scans.findById(id).exec()
      : null;
    if (!scan) throw new NotFoundException('Factura no encontrada');
    return scan;
  }

  /** Descarta la factura y borra sus imágenes del store. */
  async discard(id: string, user: JwtUser): Promise<void> {
    const scan = await this.getOrFail(id);
    if (scan.status === 'applied') {
      throw new BadRequestException(
        'Esta factura ya se aplicó: no se puede descartar.',
      );
    }
    const pathnames = scan.pages.map((p) => p.imagePathname);
    scan.status = 'discarded';
    this.addHistory(scan, user, 'discarded', 'Descartada');
    await scan.save();
    for (const pathname of pathnames) {
      await this.storage.remove(pathname);
    }
  }

  // ─── Utilidades ───────────────────────────────────────────────────────────

  private addHistory(
    scan: InvoiceScanDocument,
    user: JwtUser,
    action: ScanAction,
    detail?: string,
  ): void {
    scan.history.push({ at: new Date(), userEmail: user.email, action, detail });
  }

  /** Argumentos de `extract` a partir de la imagen guardada. */
  private async downloadArgs(url: string): Promise<[Buffer, string]> {
    const { buffer, mimetype } = await this.download(url);
    return [buffer, mimetype];
  }

  /** Descarga la imagen guardada para poder releerla sin volver a subirla. */
  private async download(
    url: string,
  ): Promise<{ buffer: Buffer; mimetype: string }> {
    const response = await fetch(url);
    if (!response.ok) {
      this.logger.error(`No se pudo descargar la imagen ${url}: ${response.status}`);
      throw new BadRequestException('No se pudo recuperar la imagen de la factura');
    }
    const mimetype = response.headers.get('content-type') ?? 'image/jpeg';
    return { buffer: Buffer.from(await response.arrayBuffer()), mimetype };
  }
}

/** Valor unitario deducido del total de la línea, si el modelo no lo leyó. */
function unitFromTotal(line: ExtractedLine): number | undefined {
  if (line.lineTotal === undefined || !line.qty) return undefined;
  return line.lineTotal / line.qty;
}

/** Total de la línea deducido del unitario. */
function totalFromUnit(line: ExtractedLine): number | undefined {
  if (line.unitCost === undefined) return undefined;
  return line.unitCost * (line.qty ?? 1);
}

/** Fecha de hoy en Colombia (UTC-5), en YYYY-MM-DD. */
function todayLocal(): string {
  return new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
}
