import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { InvitationsService } from '../application/invitations.service';
import { CreateInvitationDto } from '../application/dto/create-invitation.dto';
import { AcceptInvitationDto } from '../application/dto/accept-invitation.dto';
import { RequirePermissions } from './decorators/require-permissions.decorator';
import { Public } from './decorators/public.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import { JwtUser } from './jwt.strategy';
import { PERMISSIONS } from '../domain/permissions';
import { setRefreshCookie } from './auth-cookie';

@Controller('invitations')
export class InvitationsController {
  constructor(
    private readonly invitations: InvitationsService,
    private readonly config: ConfigService,
  ) {}

  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Get()
  list() {
    return this.invitations.list();
  }

  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Post()
  create(@Body() dto: CreateInvitationDto, @CurrentUser() user: JwtUser) {
    return this.invitations.create(dto, user.userId);
  }

  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Post(':id/resend')
  resend(@Param('id') id: string) {
    return this.invitations.resend(id);
  }

  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Delete(':id')
  @HttpCode(204)
  async revoke(@Param('id') id: string): Promise<void> {
    await this.invitations.revoke(id);
  }

  // ---- Rutas públicas para aceptar la invitación ----

  @Public()
  @Get('accept/:token')
  getByToken(@Param('token') token: string) {
    return this.invitations.getByToken(token);
  }

  @Public()
  @Post('accept/:token')
  @HttpCode(200)
  async accept(
    @Param('token') token: string,
    @Body() dto: AcceptInvitationDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.invitations.accept(token, dto);
    setRefreshCookie(res, result.tokens.refreshToken, this.config);
    return result;
  }
}
