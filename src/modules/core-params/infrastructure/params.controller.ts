import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ParamsService } from '../application/params.service';
import {
  CreateParameterDto,
  SetParameterVersionDto,
} from '../application/dto/parameter.dto';
import { RequirePermissions } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { CurrentUser } from '../../core-auth/infrastructure/decorators/current-user.decorator';
import { PERMISSIONS } from '../../core-auth/domain/permissions';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

@Controller('params')
export class ParamsController {
  constructor(private readonly params: ParamsService) {}

  @RequirePermissions(PERMISSIONS.PARAMS_MANAGE)
  @Get()
  list() {
    return this.params.list();
  }

  @RequirePermissions(PERMISSIONS.PARAMS_MANAGE)
  @Get('resolve/:key')
  resolve(
    @Param('key') key: string,
    @Query('date') date?: string,
    @Query('sedeId') sedeId?: string,
  ) {
    return this.params.resolve(key, { date, sedeId });
  }

  @RequirePermissions(PERMISSIONS.PARAMS_MANAGE)
  @Post()
  create(@Body() dto: CreateParameterDto, @CurrentUser() user: JwtUser) {
    return this.params.create(dto, user.email);
  }

  @RequirePermissions(PERMISSIONS.PARAMS_MANAGE)
  @Post(':key/versions')
  setVersion(
    @Param('key') key: string,
    @Body() dto: SetParameterVersionDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.params.setVersion(key, dto, user.email);
  }
}
