import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { BillingService } from '../application/billing.service';
import { SubscribeDto } from '../application/dto/subscribe.dto';
import { PurchaseDocsDto } from '../application/dto/purchase-docs.dto';
import { SavePaymentMethodDto } from '../application/dto/save-payment-method.dto';
import { RequirePermissions } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { Public } from '../../core-auth/infrastructure/decorators/public.decorator';
import { CurrentUser } from '../../core-auth/infrastructure/decorators/current-user.decorator';
import { PERMISSIONS } from '../../core-auth/domain/permissions';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Facturación/suscripciones (Wompi). Todo salvo el webhook exige
 * `params.manage` (nivel dueño/admin). El webhook es público (lo llama Wompi) y
 * valida el checksum del evento internamente.
 */
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  private businessId(user: JwtUser): string {
    if (!user.businessId) {
      throw new UnauthorizedException('Sesión sin empresa asociada');
    }
    return user.businessId;
  }

  @RequirePermissions(PERMISSIONS.PARAMS_MANAGE)
  @Get('config')
  config() {
    return this.billing.config();
  }

  @RequirePermissions(PERMISSIONS.PARAMS_MANAGE)
  @Get('status')
  status(@CurrentUser() user: JwtUser) {
    return this.billing.status(this.businessId(user));
  }

  /**
   * Estado real de un cobro, consultándolo a la pasarela si sigue pendiente.
   * Es lo que consulta el frontend mientras espera: el webhook puede tardar o
   * no llegar nunca (desarrollo local), y sin esto la pantalla se queda en
   * "pago en proceso" hasta el barrido del cron.
   */
  @RequirePermissions(PERMISSIONS.PARAMS_MANAGE)
  @Get('payments/:reference')
  payment(@CurrentUser() user: JwtUser, @Param('reference') reference: string) {
    return this.billing.syncPayment(this.businessId(user), reference);
  }

  /** Registra la tarjeta sin cobrar: queda guardada para los cobros siguientes. */
  @RequirePermissions(PERMISSIONS.PARAMS_MANAGE)
  @Post('payment-method')
  savePaymentMethod(
    @CurrentUser() user: JwtUser,
    @Body() dto: SavePaymentMethodDto,
  ) {
    return this.billing.savePaymentMethod(this.businessId(user), dto);
  }

  @RequirePermissions(PERMISSIONS.PARAMS_MANAGE)
  @Post('subscribe')
  subscribe(@CurrentUser() user: JwtUser, @Body() dto: SubscribeDto) {
    return this.billing.subscribe(this.businessId(user), dto);
  }

  @RequirePermissions(PERMISSIONS.PARAMS_MANAGE)
  @Post('purchase-docs')
  purchaseDocs(@CurrentUser() user: JwtUser, @Body() dto: PurchaseDocsDto) {
    return this.billing.purchaseDocs(this.businessId(user), dto.packages);
  }

  @RequirePermissions(PERMISSIONS.PARAMS_MANAGE)
  @Post('cancel')
  cancel(@CurrentUser() user: JwtUser) {
    return this.billing.cancel(this.businessId(user));
  }

  @Public()
  @Post('webhook')
  webhook(@Body() event: Parameters<BillingService['handleWebhook']>[0]) {
    return this.billing.handleWebhook(event);
  }
}
