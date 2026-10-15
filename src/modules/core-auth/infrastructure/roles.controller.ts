import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { RolesService } from '../application/roles.service';
import { CreateRoleDto } from '../application/dto/create-role.dto';
import { UpdateRoleDto } from '../application/dto/update-role.dto';
import { RequirePermissions } from './decorators/require-permissions.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import type { JwtUser } from './jwt.strategy';
import { PERMISSIONS, PERMISSION_GROUPS } from '../domain/permissions';

@Controller()
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  /** Catálogo agrupado de permisos para pintar la UI. */
  @RequirePermissions(PERMISSIONS.ROLES_MANAGE)
  @Get('permissions')
  permissions() {
    return PERMISSION_GROUPS;
  }

  // Lo puede leer quien gestiona usuarios (el formulario de usuario lo necesita).
  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Get('roles')
  list() {
    return this.roles.list();
  }

  // El usuario viaja para que nadie cree un rol con permisos que no tiene.
  @RequirePermissions(PERMISSIONS.ROLES_MANAGE)
  @Post('roles')
  create(@Body() dto: CreateRoleDto, @CurrentUser() user: JwtUser) {
    return this.roles.create(dto, user);
  }

  // El usuario viaja para que nadie se suba de rango editando roles (ni el
  // propio ni el del Dueño) ni se deje fuera quitándose `roles.manage`.
  @RequirePermissions(PERMISSIONS.ROLES_MANAGE)
  @Patch('roles/:id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateRoleDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.roles.update(id, dto, user);
  }

  @RequirePermissions(PERMISSIONS.ROLES_MANAGE)
  @Delete('roles/:id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    await this.roles.remove(id);
  }
}
