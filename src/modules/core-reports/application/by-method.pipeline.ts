import type { PipelineStage } from 'mongoose';

/**
 * Ventas por medio de pago (faceta `byMethod` del reporte de ventas).
 *
 * Un cobro mixto (ítem 6.9) aparece en cada medio que usó: el ingreso se
 * reparte en proporción a lo que cubrió cada medio (así la suma por medios
 * sigue siendo el ingreso total) y `collected` es lo que de verdad entró por
 * ese medio, con propina y domicilio. Un tiquete mixto cuenta en cada medio.
 *
 * Las ventas de un solo medio no traen `payments`: su medio cubrió todo.
 */
const COBRADO = {
  $add: [
    '$total',
    { $ifNull: ['$tip', 0] },
    { $ifNull: ['$deliveryFee', 0] },
  ],
};

export const BY_METHOD_PIPELINE: PipelineStage.FacetPipelineStage[] = [
  {
    $project: {
      total: 1,
      due: COBRADO,
      parts: {
        $cond: [
          { $gt: [{ $size: { $ifNull: ['$payments', []] } }, 0] },
          '$payments',
          [{ method: '$payment.method', amount: COBRADO }],
        ],
      },
    },
  },
  { $unwind: '$parts' },
  {
    $group: {
      _id: '$parts.method',
      revenue: {
        $sum: {
          $cond: [
            { $gt: ['$due', 0] },
            { $multiply: ['$total', { $divide: ['$parts.amount', '$due'] }] },
            '$total',
          ],
        },
      },
      collected: { $sum: '$parts.amount' },
      tickets: { $sum: 1 },
    },
  },
  { $set: { revenue: { $round: ['$revenue', 0] } } },
  { $sort: { revenue: -1 } },
];
