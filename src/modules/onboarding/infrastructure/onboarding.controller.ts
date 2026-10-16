import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { OnboardingService } from '../application/onboarding.service';
import { AplicarPlantillaDto } from '../application/dto/aplicar-plantilla.dto';
import { RequirePermissions } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { CurrentUser } from '../../core-auth/infrastructure/decorators/current-user.decorator';
import { PERMISSIONS } from '../../core-auth/domain/permissions';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/** Primera venta en minutos (ítem 6.6): plantillas de menú y catálogo de ejemplo. */
@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  /** Plantillas disponibles y cuántos productos propios tiene ya la empresa. */
  @RequirePermissions(PERMISSIONS.ONBOARDING_TEMPLATE)
  @Get('plantillas')
  estado() {
    return this.onboarding.estado();
  }

  /** Carga la plantilla. Idempotente; con productos propios exige `confirmar`. */
  @RequirePermissions(PERMISSIONS.ONBOARDING_TEMPLATE)
  @HttpCode(200)
  @Post('plantilla')
  aplicar(@Body() dto: AplicarPlantillaDto, @CurrentUser() user: JwtUser) {
    return this.onboarding.aplicar(dto, user);
  }
}
