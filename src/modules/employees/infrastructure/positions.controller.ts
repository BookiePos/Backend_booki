import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { PositionsService } from '../application/positions.service';
import { CreatePositionDto } from '../application/dto/create-position.dto';
import { UpdatePositionDto } from '../application/dto/update-position.dto';
import { RequirePermissions } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { PERMISSIONS } from '../../core-auth/domain/permissions';

@Controller('positions')
export class PositionsController {
  constructor(private readonly positions: PositionsService) {}

  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Get()
  list(@Query('includeInactive') includeInactive?: string) {
    return this.positions.list(includeInactive === 'true');
  }

  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Post()
  create(@Body() dto: CreatePositionDto) {
    return this.positions.create(dto);
  }

  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdatePositionDto) {
    return this.positions.update(id, dto);
  }

  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.positions.remove(id);
    return { ok: true };
  }
}
