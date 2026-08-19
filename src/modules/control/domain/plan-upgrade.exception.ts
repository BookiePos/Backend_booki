import { HttpException, HttpStatus } from '@nestjs/common';
import type { PlanFeature } from './plans';

export type PlanBlockReason = 'feature' | 'quota';

/**
 * 402 Payment Required: la acción existe pero el PLAN del tenant no la incluye
 * (feature bloqueada) o superó una cuota. El frontend distingue este código
 * (`PLAN_UPGRADE_REQUIRED`) para mostrar el upsell de "mejora tu plan".
 */
export class PlanUpgradeRequiredException extends HttpException {
  constructor(
    message: string,
    details: { reason: PlanBlockReason; feature?: PlanFeature; quota?: string },
  ) {
    super(
      {
        statusCode: HttpStatus.PAYMENT_REQUIRED,
        error: 'Payment Required',
        code: 'PLAN_UPGRADE_REQUIRED',
        message,
        ...details,
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}
