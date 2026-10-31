/**
 * Datos del documento equivalente electrónico POS que no salen de la venta en
 * sí (anexo DE v1.0 §8.2.1 y Res. 165/2023 art. 19): la caja donde se cobró,
 * el fabricante del software y el reparto del pago.
 *
 * Se congelan en `electronic_documents` al emitir; el builder UBL del POS
 * (PR 7A, `prepararPosUbl`) los lee de ahí para armar las extensiones
 * `PuntoVenta`, `FabricanteSoftware` y los `PaymentMeans`.
 *
 * Dominio puro: sin Nest ni Mongoose.
 */
import {
  salePartsOf,
  type SalePaymentsView,
} from '../../sales/domain/sale-payments';
import { normalizarNit } from './consecutivo-unico';

/** Cómo sale el POS: consumidor final (por defecto) o con datos del cliente. */
export const MODOS_POS = ['anonimo', 'identificado'] as const;
export type ModoPos = (typeof MODOS_POS)[number];

/** Una caja (punto de venta) de la sede, configurada en `sede.puntosVenta`. */
export interface PuntoVenta {
  placa?: string;
  ubicacion?: string;
  tipo?: string;
}

/**
 * Tipo de caja cuando la sede no configuró ninguna. El anexo no trae una lista
 * cerrada de valores para `TipoCaja` (DEPD27): a confirmar en habilitación.
 */
export const PUNTO_VENTA_POR_DEFECTO = { tipo: 'Caja principal' } as const;

/** `InformacionCajaVenta` (DEPD21–36), salvo `SubTotal`, que es el `taxableBase`. */
export interface CajaVentaPos {
  placa: string;
  ubicacion: string;
  tipo: string;
  cajero: string;
  codigoVenta: string;
}

/**
 * Caja de la venta. BookiPos no tiene la caja como entidad (los turnos son por
 * sede), así que se toma la primera de `sede.puntosVenta` y, sin ninguna, una
 * por defecto con el código de la sede como placa y su dirección como
 * ubicación: el XML nunca sale sin la extensión, que es de rechazo (§10.2.1.2).
 */
export function cajaVentaPos(
  sede: {
    code: string;
    name: string;
    address?: string;
    puntosVenta?: PuntoVenta[] | null;
  },
  sale: {
    saleNumber: string;
    cashierName?: string;
    cashierEmail: string;
    seller?: { name?: string } | null;
  },
): CajaVentaPos {
  const pv = sede.puntosVenta?.[0];
  return {
    placa: pv?.placa?.trim() || sede.code.toUpperCase(),
    ubicacion: pv?.ubicacion?.trim() || sede.address?.trim() || sede.name,
    tipo: pv?.tipo?.trim() || PUNTO_VENTA_POR_DEFECTO.tipo,
    cajero:
      sale.cashierName?.trim() || sale.seller?.name?.trim() || sale.cashierEmail,
    codigoVenta: sale.saleNumber,
  };
}

/**
 * Fabricante del software (`InformacionDelFabricanteDelSoftware`, DEAB37–46;
 * art. 19 num. 10). Es el mismo para todos los negocios: BookiPos. Viene del
 * entorno porque la razón social y el NIT son una tarea pendiente del dueño;
 * sin ellos sale «BookiPos» como nombre, que basta para habilitación.
 */
export interface FabricanteSoftware {
  nombreApellido: string;
  razonSocial?: string;
  /** NIT del fabricante, sin DV. Lo imprime el tiquete (art. 19 num. 10). */
  nit?: string;
  nombreSoftware: string;
}

export function fabricanteDesdeEntorno(
  env: Record<string, string | undefined>,
): FabricanteSoftware {
  const f: FabricanteSoftware = {
    nombreApellido: env.FE_FABRICANTE_NOMBRE?.trim() || 'BookiPos',
    nombreSoftware: env.FE_FABRICANTE_SOFTWARE?.trim() || 'BookiPos',
  };
  const razon = env.FE_FABRICANTE_RAZON_SOCIAL?.trim();
  if (razon) f.razonSocial = razon;
  const nit = normalizarNit(env.FE_FABRICANTE_NIT);
  if (nit) f.nit = nit;
  return f;
}

/**
 * Una parte del pago del POS (`PaymentMeans` 1..N, DEAN01–05). Se guarda el
 * medio de BookiPos tal cual (método, tarjeta, canal); el código DIAN (10, 47,
 * 48, 49…) lo pone el builder del PR 7A, que es dueño de esa tabla.
 */
export interface PagoPos {
  metodo: string;
  monto: number;
  /** '1' contado, '2' crédito (fiado). */
  formaPago: '1' | '2';
  tipoTarjeta?: string;
  canal?: string;
  /** Vencimiento (YYYY-MM-DD) del fiado, si se conoce. DEAN04 la exige con forma 2. */
  vence?: string;
}

/** Pago mixto = una parte por medio (D10). Lee la venta con `salePartsOf`. */
export function pagosPos(sale: SalePaymentsView): PagoPos[] {
  return salePartsOf(sale).map((p) => {
    const pago: PagoPos = {
      metodo: p.method,
      monto: p.amount,
      formaPago: p.method === 'credit' ? '2' : '1',
    };
    if (p.cardType) pago.tipoTarjeta = p.cardType;
    if (p.channel) pago.canal = p.channel;
    return pago;
  });
}
