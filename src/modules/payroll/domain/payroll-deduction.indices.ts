/**
 * Un solo arrastre VIVO por (corrida de origen, empleado). El cierre de la
 * corrida lo crea con un upsert, pero dos cierres simultáneos pasan los dos el
 * chequeo de estado y el upsert solo no basta: sin este índice podrían quedar
 * dos arrastres y al trabajador se le descontaría el doble.
 *
 * Los anulados no cuentan: al anularse, `sourceId` se renombra a
 * `sourceIdAnulado` y sale del índice (`$type: 'string'`), así un nuevo cierre
 * tras recalcular no choca. Se filtra por igualdad y `$type`, que admite
 * cualquier versión de Mongo con índices parciales, y no con `status: {$in}`.
 */
export const INDICE_ARRASTRE_VIVO = {
  keys: { source: 1, sourceId: 1, employeeId: 1 },
  options: {
    name: 'arrastre_vivo_unico',
    unique: true,
    partialFilterExpression: {
      source: 'arrastre',
      sourceId: { $type: 'string' },
    },
  },
} as const;
