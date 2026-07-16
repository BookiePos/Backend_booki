import { Body, Controller, Get, Post } from '@nestjs/common';
import { UsersService } from '../application/users.service';
import { CreateUserDto } from '../application/dto/create-user.dto';
import { RequirePermissions } from './decorators/require-permissions.decorator';
import { PERMISSIONS } from '../domain/permissions';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Get()
  list() {
    return this.users.list();
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
}
