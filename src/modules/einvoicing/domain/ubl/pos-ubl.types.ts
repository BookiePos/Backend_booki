import type { FacturaUbl, PagoUbl } from './factura-ubl';

/**
 * Contrato común de la Fase 7 (anexo `fe-fase7-anexo-pos.md` §6): la entrada del
 * builder del documento equivalente electrónico POS y la forma en que el
 * documento `type: 'pos'` guarda en `electronic_documents` lo que el builder
 * necesita además de lo de la factura. 7A (builder) y 7B (emisión) importan de
 * aquí; ninguno redefine estas formas.
 */

/**
 * Extensión `PuntoVenta/InformacionCajaVenta` (anexo DE v1.0 §10.2.1.2,
 * DEPD21-36). `SubTotal` no se pide: es el `LineExtensionAmount` del documento.
 * Cada valor, 1 a 100 caracteres.
 */
export interface CajaVentaUbl {
  /** `PlacaCaja`: placa de inventario de la caja. */
  placa: string;
  /** `UbicaciónCaja`. */
  ubicacion: string;
  /** `TipoCaja`. */
  tipo: string;
  /** `Cajero`: nombres y apellidos del cajero o vendedor. */
  cajero: string;
  /** `CódigoVenta`: el número de la venta en BookiPos. */
  codigoVenta: string;
}

/**
 * Extensión `FabricanteSoftware/InformacionDelFabricanteDelSoftware` (DEAB37-46;
 * art. 19 num. 10 de la Res. 165/2023). El fabricante es quien hace BookiPos,
 * no el negocio que vende.
 */
export interface FabricanteSoftwareUbl {
  /** `NombreApellido` (1..1). */
  nombreApellido: string;
  /** `RazonSocial` (0..1). */
  razonSocial?: string;
  /** `NombreSoftware` (1..1). */
  nombreSoftware: string;
}

/** Un `cac:PaymentMeans` del POS: pago mixto = varios (DEAN01-05). */
export type PagoPosUbl = PagoUbl;

/**
 * Entrada de `armarPosUbl`: la de la factura más la caja, el fabricante y los
 * pagos. En el POS:
 *
 * - `cufe` lleva el **CUDE** (`calcularCudePos`, con el PIN).
 * - `pagos` manda (1..N); `formaPago`/`medioPago`/`vencimiento` heredados son
 *   los del primer pago y no se escriben aparte.
 */
export interface PosUbl extends FacturaUbl {
  cajaVenta: CajaVentaUbl;
  fabricante: FabricanteSoftwareUbl;
  pagos: PagoPosUbl[];
}

/**
 * Una parte del pago tal como la guarda la emisión del POS (PR 7B,
 * `PagoPos` de `emision-pos.ts`): el medio de BookiPos, no el código DIAN. El
 * código (10, 47, 48, 49…) lo pone el builder con `pagoPosDian`.
 */
export interface PagoPosDocumento {
  /** `cash`, `card`, `transfer`, `credit`, `platform`. */
  metodo?: string;
  monto?: number;
  /** '1' contado, '2' crédito (fiado). */
  formaPago?: string;
  /** `debit` | `credit` (solo tarjeta). */
  tipoTarjeta?: string;
  /** `datafono`, `nequi`, `daviplata`, `qr`. */
  canal?: string;
  /** YYYY-MM-DD del fiado, si se conoce. Sin ella se usa la fecha de emisión. */
  vence?: string;
}

/**
 * Lo que el documento `type: 'pos'` guardado trae, además de lo que ya guarda
 * la factura (`DocumentoParaUbl`), para que `prepararPosUbl` lo arme. Es la
 * forma que escribe el PR 7B: una copia congelada al emitir, como el emisor y
 * el adquiriente.
 *
 * - `cufe` del documento: el CUDE.
 * - `fabricante.nit` se acepta pero no va al XML: el anexo no lo pide en la
 *   extensión (DEAB37-46); lo usa el tiquete impreso.
 */
export interface CamposPosDocumento {
  cajaVenta?: Partial<CajaVentaUbl>;
  fabricante?: Partial<FabricanteSoftwareUbl> & { nit?: string };
  pagos?: PagoPosDocumento[];
}
