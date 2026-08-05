import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { dbNameForBusiness } from '../../../shared/tenancy/tenant-context';
import {
  BusinessPlan,
  BusinessType,
  CONTROL_CONNECTION,
  TRIAL_DAYS,
} from '../domain/control.constants';
import {
  Business,
  BusinessDocument,
} from '../infrastructure/schemas/business.schema';

export interface CreateBusinessInput {
  name: string;
  nit?: string;
  plan: BusinessPlan;
  tipoNegocio: BusinessType;
  ownerEmail: string;
}

/**
 * Alta y consulta de empresas en la base de control. Cada empresa nueva fija su
 * `dbName = biz_<_id>` en el momento de crearse; esa base la provisiona luego el
 * RegistrationService (roles, sede, dueño).
 */
@Injectable()
export class BusinessService {
  constructor(
    @InjectModel(Business.name, CONTROL_CONNECTION)
    private readonly businesses: Model<BusinessDocument>,
  ) {}

  async create(input: CreateBusinessInput): Promise<BusinessDocument> {
    const _id = new Types.ObjectId();
    const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 86400 * 1000);
    return this.businesses.create({
      _id,
      name: input.name.trim(),
      nit: input.nit?.trim(),
      plan: input.plan,
      tipoNegocio: input.tipoNegocio,
      status: 'trial',
      trialEndsAt,
      dbName: dbNameForBusiness(_id.toString()),
      ownerEmail: input.ownerEmail.toLowerCase(),
    });
  }

  findById(id: string): Promise<BusinessDocument | null> {
    return this.businesses.findById(id).exec();
  }

  /**
   * Empresas operativas (trial o activas) con su base de datos. Lo usan los
   * procesos programados para iterar tenant por tenant abriendo su contexto.
   */
  listActive(): Promise<BusinessDocument[]> {
    return this.businesses
      .find({ status: { $in: ['trial', 'active'] } })
      .select('_id dbName tipoNegocio status')
      .exec();
  }

  /** ¿Ya existe una empresa con este NIT? (unicidad a nivel plataforma). */
  async nitExists(nit: string): Promise<boolean> {
    const clean = nit.trim();
    if (!clean) return false;
    return (await this.businesses.exists({ nit: clean })) != null;
  }
}
