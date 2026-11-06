import { describe, it, expect } from 'vitest';
import { planSaldoFavorHistorico } from './saldo-favor-historico';

/** Saldo a favor histórico (revisión 6C): atribución por cliente, idempotente. */
describe('planSaldoFavorHistorico', () => {
  const ventas = new Map([
    ['v1', { id: 'v1', saleNumber: 'FV-1', customerId: 'c1', customerName: 'Ana' }],
    ['v2', { id: 'v2', saleNumber: 'FV-2', docNumber: '1.020.304' }],
    ['v3', { id: 'v3', saleNumber: 'FV-3', docNumber: '999' }],
    ['v4', { id: 'v4', saleNumber: 'FV-4' }],
  ]);
  const clientes = new Map([['1020304', { id: 'c2', name: 'Beto' }]]);

  it('atribuye por customerId o por documento, con el monto que acreditó la 2805', () => {
    const plan = planSaldoFavorHistorico(
      [
        { id: 'r1', saleId: 'v1', refundMethod: 'credit_note', refundTotal: 10_000, abonoCartera: 4_000, tipRefund: 500 },
        { id: 'r2', saleId: 'v2', refundMethod: 'none', refundTotal: 3_000 },
        { id: 'r3', saleId: 'v1', refundMethod: 'cash', refundTotal: 9_000 },
      ],
      ventas,
      clientes,
      new Set(),
    );
    expect(plan.abonos).toEqual([
      { returnId: 'r1', customerId: 'c1', customerName: 'Ana', amount: 6_500, memo: 'Saldo a favor histórico de la venta FV-1' },
      { returnId: 'r2', customerId: 'c2', customerName: 'Beto', amount: 3_000, memo: 'Saldo a favor histórico de la venta FV-2' },
    ]);
  });

  it('informa lo que no puede atribuir y salta lo ya atribuido (idempotente)', () => {
    const plan = planSaldoFavorHistorico(
      [
        { id: 'r1', saleId: 'v1', refundMethod: 'credit_note', refundTotal: 1_000 },
        { id: 'r4', saleId: 'v3', refundMethod: 'credit_note', refundTotal: 2_000 },
        { id: 'r5', saleId: 'v4', refundMethod: 'none', refundTotal: 3_000 },
        { id: 'r6', saleId: 'v9', refundMethod: 'credit_note', refundTotal: 4_000 },
        { id: 'r7', saleId: 'v1', refundMethod: 'credit_note', refundTotal: 1_000, abonoCartera: 1_000 },
      ],
      ventas,
      clientes,
      new Set(['r1']),
    );
    expect(plan.abonos).toHaveLength(0);
    expect(plan.yaAtribuidas).toBe(1);
    expect(plan.sinCliente.map((s) => [s.returnId, s.motivo])).toEqual([
      ['r4', 'el documento de la venta no es de ningún cliente registrado'],
      ['r5', 'la venta no tiene documento del cliente'],
      ['r6', 'la venta ya no existe'],
    ]);
  });
});
