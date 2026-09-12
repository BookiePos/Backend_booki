/**
 * Domicilios: cómo sale el pedido y cuánto se cobra por llevarlo.
 *
 * La tarifa NO se calcula por kilómetros. Se decidió así con el dueño y vale la
 * pena que quede escrito: una API de mapas cobra por consulta, hay que pagarla
 * todos los meses, y en Medellín se equivoca — dos direcciones a 800 metros en
 * línea recta pueden estar separadas por una montaña. El repartidor sabe mejor
 * que el mapa lo que cuesta subir a Belén.
 *
 * Así que son ZONAS con precio fijo, más una casilla para escribir el valor a
 * mano en el pedido raro que no cae en ninguna.
 */

/** Cómo sale el pedido del negocio. */
export const ORDER_TYPES = [
  'mostrador', // se lo lleva puesto quien vino a comprar
  'mesa', // se consume ahí (restaurante)
  'llevar', // pide y se lo lleva
  'domicilio', // se lo llevamos nosotros
] as const;

export type OrderType = (typeof ORDER_TYPES)[number];

export const ORDER_TYPE_LABELS: Record<OrderType, string> = {
  mostrador: 'Mostrador',
  mesa: 'Mesa',
  llevar: 'Para llevar',
  domicilio: 'Domicilio',
};

/** Tope de cordura de una tarifa: más allá es un cero de más al teclear. */
export const MAX_DELIVERY_FEE = 1_000_000;

/** Datos de entrega que llegan con la venta. */
export interface DeliveryInput {
  address?: string;
  phone?: string;
  notes?: string;
  courier?: string;
  zoneId?: string;
  /** Tarifa escrita a mano, para el pedido que no cae en ninguna zona. */
  fee?: number;
}

/** Una zona ya cargada de la base, con su tarifa. */
export interface ZoneRef {
  id: string;
  name: string;
  fee: number;
}

export interface ResolvedDelivery {
  zoneId?: string;
  zoneName?: string;
  fee: number;
  address: string;
  phone?: string;
  notes?: string;
  courier?: string;
}

/**
 * Decide qué se cobra por llevar el pedido y valida que tenga sentido.
 *
 * El orden importa: la zona manda sobre la tarifa escrita a mano. Si alguien
 * elige "Laureles" y además teclea otro valor, se cobra el de Laureles — las
 * zonas existen justamente para que el precio no dependa de quién tome el
 * pedido.
 *
 * Lanza `Error` con el motivo en llano; quien llama lo traduce a 400.
 */
export function resolveDelivery(
  input: DeliveryInput | undefined,
  zone: ZoneRef | null,
): ResolvedDelivery {
  const address = input?.address?.trim() ?? '';
  if (!address) {
    // Un domicilio sin dirección no se puede entregar, y el cobro quedaría
    // hecho igual. Mejor no dejar registrar la venta.
    throw new Error('Un domicilio necesita la dirección de entrega');
  }

  let fee: number;
  if (zone) {
    fee = zone.fee;
  } else if (input?.zoneId) {
    throw new Error('La zona de domicilio no existe o está desactivada');
  } else if (input?.fee !== undefined) {
    const valor = Number(input.fee);
    if (!Number.isFinite(valor) || valor < 0) {
      throw new Error('El valor del domicilio no puede ser negativo');
    }
    if (valor > MAX_DELIVERY_FEE) {
      throw new Error('El valor del domicilio es demasiado alto; revisa si sobra un cero');
    }
    fee = Math.round(valor);
  } else {
    // Domicilio gratis: es una decisión comercial válida y bastante común.
    fee = 0;
  }

  return {
    zoneId: zone?.id,
    zoneName: zone?.name,
    fee,
    address,
    phone: input?.phone?.trim() || undefined,
    notes: input?.notes?.trim() || undefined,
    courier: input?.courier?.trim() || undefined,
  };
}
