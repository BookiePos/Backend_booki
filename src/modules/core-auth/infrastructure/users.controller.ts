import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { UsersService } from '../application/users.service';
import { CreateUserDto } from '../application/dto/create-user.dto';
import { UpdateUserDto } from '../application/dto/update-user.dto';
import { RequirePermissions } from './decorators/require-permissions.decorator';
import { PERMISSIONS } from '../domain/permissions';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Get()
  async list() {
    const users = await this.users.list();
    return users.map((user) => ({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      active: user.active,
      extraPermissions: user.extraPermissions,
      sedeIds: user.sedeIds.map((s) => s.toString()),
      createdAt: (user as unknown as { createdAt?: Date }).createdAt,
    }));
  }

  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Post()
  async create(@Body() dto: CreateUserDto) {
    const user = await this.users.create(dto);
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    };
  }

  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    const user = await this.users.update(id, dto);
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      active: user.active,
      extraPermissions: user.extraPermissions,
      sedeIds: user.sedeIds.map((s) => s.toString()),
      createdAt: (user as unknown as { createdAt?: Date }).createdAt,
    };
  }
}
