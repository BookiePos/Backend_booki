/**
 * Una sola primera quincena PAGADA por (mes, trabajador). `registrar` ya lo
 * comprueba, pero entre esa lectura y la escritura hay varias consultas: un
 * doble clic mandaba dos pagos, los dos veían al trabajador sin quincena y se
 * asentaban dos salidas de caja (auditoría de dinero, 20-nov-2026).
 *
 * Es multikey sobre `lineas.employeeId`: Mongo hace cumplir la unicidad entre
 * documentos distintos. Al anular, `estado` pasa a 'anulada' y el pago sale del
 * índice, así se puede volver a registrar.
 */
export const INDICE_QUINCENA_VIVA = {
  keys: { period: 1, 'lineas.employeeId': 1 },
  options: {
    name: 'quincena_viva_unica',
    unique: true,
    partialFilterExpression: { estado: 'pagada' },
  },
} as const;
