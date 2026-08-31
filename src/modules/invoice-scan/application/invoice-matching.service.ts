import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ProductsService } from '../../inventory/application/products.service';
import { SuppliersService } from '../../suppliers/application/suppliers.service';
import { ProductDocument } from '../../inventory/infrastructure/schemas/product.schema';
import {
  SupplierItemAlias,
  SupplierItemAliasDocument,
} from '../infrastructure/schemas/supplier-item-alias.schema';
import { ExtractedInvoice, ExtractedLine } from '../domain/invoice-extraction';
import { normalizeText, similarity } from '../domain/text-normalize';
import { proposeLineTarget } from '../domain/line-classification';
import {
  LineTarget,
  NAME_MATCH_THRESHOLD,
} from '../domain/invoice-scan.constants';

export interface SupplierMatch {
  supplierId?: string;
  supplierName?: string;
  /** matched = existe por NIT · new = hay datos para crearlo · unknown = ni eso. */
  mode: 'matched' | 'new' | 'unknown';
}

export interface LineMatch {
  lineIndex: number;
  target: LineTarget;
  productId?: string;
  createProduct: boolean;
  matchedBy: 'alias' | 'barcode' | 'sku' | 'name' | 'none';
  /** Motivo legible, para explicarle a la persona por qué se propuso esto. */
  reason: string;
}

/**
 * Empareja lo que dice la factura con lo que ya existe en la empresa.
 *
 * Todo lo que produce es una **propuesta**: la pantalla de revisión la muestra
 * marcada y la persona confirma o corrige. Por eso el criterio es conservador:
 * ante la duda, proponer "crear nuevo" en vez de adivinar. Emparejar mal suma
 * stock al producto equivocado y descuadra dos inventarios de una vez; no
 * emparejar solo cuesta un clic.
 */
@Injectable()
export class InvoiceMatchingService {
  constructor(
    private readonly products: ProductsService,
    private readonly suppliers: SuppliersService,
    @InjectModel(SupplierItemAlias.name)
    private readonly aliases: Model<SupplierItemAliasDocument>,
  ) {}

  /** Busca el proveedor por el documento leído en la factura. */
  async matchSupplier(draft: ExtractedInvoice): Promise<SupplierMatch> {
    const { name, docNumber, docType } = draft.supplier;
    if (docNumber) {
      const found = await this.suppliers.findByDocNumber(
        docType ?? 'NIT',
        docNumber,
      );
      if (found) {
        return { supplierId: found.id as string, supplierName: found.name, mode: 'matched' };
      }
    }
    // Sin coincidencia: si al menos hay nombre, la interfaz ofrece crearlo con
    // lo leído; si no, toca elegirlo a mano.
    return { supplierName: name, mode: name ? 'new' : 'unknown' };
  }

  /**
   * Propone destino y producto para cada renglón.
   *
   * Orden de preferencia: alias aprendido → código de barras → SKU → nombre.
   * El alias va primero porque es la única señal que ya validó una persona.
   */
  async matchLines(
    lines: ExtractedLine[],
    supplierId?: string,
  ): Promise<LineMatch[]> {
    const catalog = await this.products.list();
    const aliasMap = await this.aliasMap(supplierId);

    const bySku = new Map<string, ProductDocument>();
    const byBarcode = new Map<string, ProductDocument[]>();
    for (const product of catalog) {
      bySku.set(product.sku.toUpperCase(), product);
      if (product.barcode) {
        const list = byBarcode.get(product.barcode) ?? [];
        list.push(product);
        byBarcode.set(product.barcode, list);
      }
    }

    return lines.map((line, lineIndex) => {
      const proposal = proposeLineTarget(line);
      if (proposal.target !== 'inventory') {
        return {
          lineIndex,
          target: proposal.target,
          createProduct: false,
          matchedBy: 'none' as const,
          reason: proposal.reason,
        };
      }

      const aliasId = aliasMap.get(normalizeText(line.description));
      if (aliasId) {
        return {
          lineIndex,
          target: 'inventory',
          productId: aliasId,
          createProduct: false,
          matchedBy: 'alias',
          reason: 'Ya habías emparejado esta línea de este proveedor',
        };
      }

      if (line.barcode) {
        const candidates = byBarcode.get(line.barcode.trim()) ?? [];
        // El índice de barcode NO es único en el repo: con más de un candidato
        // no hay forma de saber cuál es, así que se baja al siguiente criterio.
        const single = candidates.length === 1 ? candidates[0] : undefined;
        if (single) {
          return {
            lineIndex,
            target: 'inventory',
            productId: single.id as string,
            createProduct: false,
            matchedBy: 'barcode',
            reason: `Código de barras ${line.barcode}`,
          };
        }
      }

      if (line.code) {
        const bySkuHit = bySku.get(line.code.trim().toUpperCase());
        if (bySkuHit) {
          return {
            lineIndex,
            target: 'inventory',
            productId: bySkuHit.id as string,
            createProduct: false,
            matchedBy: 'sku',
            reason: `SKU ${bySkuHit.sku}`,
          };
        }
      }

      const best = bestByName(catalog, line.description);
      if (best) {
        return {
          lineIndex,
          target: 'inventory',
          productId: best.product.id as string,
          createProduct: false,
          matchedBy: 'name',
          reason: `Se parece a "${best.product.name}"`,
        };
      }

      return {
        lineIndex,
        target: 'inventory',
        createProduct: true,
        matchedBy: 'none',
        reason: 'No existe en el inventario: se creará',
      };
    });
  }

  /**
   * Recuerda que este proveedor llama así a este producto. Se invoca al
   * aplicar: a partir de la segunda factura, esa línea se empareja sola.
   */
  async rememberAlias(
    supplierId: string,
    rawText: string,
    productId: string,
  ): Promise<void> {
    const normalized = normalizeText(rawText);
    if (!normalized) return;
    await this.aliases
      .updateOne(
        { supplierId: new Types.ObjectId(supplierId), rawText: normalized },
        {
          $set: {
            productId: new Types.ObjectId(productId),
            lastUsedAt: new Date(),
          },
          $inc: { hits: 1 },
        },
        { upsert: true },
      )
      .exec();
  }

  private async aliasMap(supplierId?: string): Promise<Map<string, string>> {
    if (!supplierId || !Types.ObjectId.isValid(supplierId)) return new Map();
    const rows = await this.aliases
      .find({ supplierId: new Types.ObjectId(supplierId) })
      .exec();
    return new Map(rows.map((r) => [r.rawText, r.productId.toString()]));
  }
}

/** Mejor candidato por nombre, o null si ninguno llega al umbral. */
function bestByName(
  catalog: ProductDocument[],
  description: string,
): { product: ProductDocument; score: number } | null {
  let best: { product: ProductDocument; score: number } | null = null;
  for (const product of catalog) {
    const score = similarity(description, product.name);
    if (score >= NAME_MATCH_THRESHOLD && (!best || score > best.score)) {
      best = { product, score };
    }
  }
  return best;
}
