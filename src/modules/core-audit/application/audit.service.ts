import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  AuditLog,
  AuditLogDocument,
} from '../infrastructure/schemas/audit-log.schema';

export interface AuditRecord {
  userId?: string;
  userEmail?: string;
  userName?: string;
  role?: string;
  method: string;
  path: string;
  statusCode?: number;
  success: boolean;
  ip?: string;
  durationMs?: number;
  error?: string;
}

export interface AuditQuery {
  userEmail?: string;
  module?: string;
  from?: string;
  to?: string;
  method?: string;
  limit?: number;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger('Audit');

  constructor(
    @InjectModel(AuditLog.name)
    private readonly logs: Model<AuditLogDocument>,
  ) {}

  /** Primer segmento de la ruta ('/finance/expenses' → 'finance'). */
  private moduleOf(path: string): string {
    const seg = path.replace(/^\/+/, '').split(/[/?]/)[0];
    return seg || '/';
  }

  /**
   * Registra un evento. Nunca lanza: la auditoría no debe tumbar la operación
   * de negocio si la escritura del log falla.
   */
  async record(rec: AuditRecord): Promise<void> {
    try {
      await this.logs.create({
        ...rec,
        module: this.moduleOf(rec.path),
      });
    } catch (err) {
      this.logger.warn(
        `No se pudo registrar auditoría: ${(err as Error).message}`,
      );
    }
  }

  async list(query: AuditQuery): Promise<AuditLogDocument[]> {
    const filter: Record<string, unknown> = {};
    if (query.userEmail) filter.userEmail = query.userEmail;
    if (query.module) filter.module = query.module;
    if (query.method) filter.method = query.method.toUpperCase();
    if (query.from || query.to) {
      const range: Record<string, Date> = {};
      if (query.from) range.$gte = new Date(`${query.from}T00:00:00`);
      if (query.to) range.$lte = new Date(`${query.to}T23:59:59.999`);
      filter.at = range;
    }
    const limit = Math.min(Math.max(query.limit ?? 200, 1), 1000);
    return this.logs.find(filter).sort({ at: -1 }).limit(limit).exec();
  }

  /** Módulos distintos vistos (para poblar el filtro de la UI). */
  async modules(): Promise<string[]> {
    const values = await this.logs.distinct('module').exec();
    return (values as string[]).filter(Boolean).sort();
  }
}
