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

  @RequirePermissions(PERMISSIONS.ROLES_MANAGE)
  @Post('roles')
  create(@Body() dto: CreateRoleDto) {
    return this.roles.create(dto);
  }

  @RequirePermissions(PERMISSIONS.ROLES_MANAGE)
  @Patch('roles/:id')
  update(@Param('id') id: string, @Body() dto: UpdateRoleDto) {
    return this.roles.update(id, dto);
  }

  @RequirePermissions(PERMISSIONS.ROLES_MANAGE)
  @Delete('roles/:id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    await this.roles.remove(id);
  }
}
