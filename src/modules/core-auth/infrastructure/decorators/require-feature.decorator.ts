import { SetMetadata } from '@nestjs/common';
import type { PlanFeature } from '../../../control/domain/plans';

export const FEATURE_KEY = 'requiredFeature';

/** Exige que el plan del tenant incluya `feature` (lo evalúa FeatureGuard). */
export const RequireFeature = (feature: PlanFeature) =>
  SetMetadata(FEATURE_KEY, feature);
