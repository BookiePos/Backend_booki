import { cop } from '../modules/finance/domain/money.util';

/**
 * Pagos de la suscripción (control-plane) que el código anterior a la
 * reserva por versión dejó en `approved` sin `applied`.
 *
 * El protocolo nuevo de `BillingService.applyApproved` anota qué efectos hizo
 * (`effectsDone`) y marca `applyVersion`; el anterior no. Una fila así no dice
 * si ya se acreditaron los documentos o se abrió el período, así que el
 * barrido NO la retoma: re-aplicarla a ciegas podría duplicarlos. Se listan
 * para revisarlas a mano contra Wompi y el estado de la empresa.
 */
export const FILTRO_PAGOS_LEGADO = {
  status: 'approved',
  applied: { $ne: true },
  applyVersion: { $exists: false },
} as const;

export interface PagoLegado {
  id: string;
  reference: string;
  kind: string;
  amountInCents: number;
}

/** Conteo por tipo y monto total en pesos (COP entero). */
export function contarLegado(pagos: readonly PagoLegado[]): Record<string, number> {
  const porTipo = (k: string) => pagos.filter((p) => p.kind === k).length;
  const centavos = pagos.reduce((acc, p) => acc + (p.amountInCents ?? 0), 0);
  return {
    pagos: pagos.length,
    docPackage: porTipo('docPackage'),
    subscription: porTipo('subscription'),
    renewal: porTipo('renewal'),
    montoCop: cop(centavos / 100),
  };
}
