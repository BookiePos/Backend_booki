import { Controller, Get } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { Public } from '../../core-auth/infrastructure/decorators/public.decorator';

/** Mapea el readyState numérico de Mongoose a un texto legible. */
const READY_STATE: Record<number, string> = {
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
};

@Controller('health')
export class HealthController {
  constructor(
    @InjectConnection() private readonly connection: Connection,
  ) {}

  @Public()
  @Get()
  check(): { status: string; db: string; time: string } {
    const db = READY_STATE[this.connection.readyState] ?? 'unknown';
    return {
      status: 'ok',
      db,
      time: new Date().toISOString(),
    };
  }
}
