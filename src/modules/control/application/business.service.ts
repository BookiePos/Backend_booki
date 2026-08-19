import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { dbNameForBusiness } from '../../../shared/tenancy/tenant-context';
import {
  BusinessPlan,
  BusinessStatus,
  BusinessType,
  CONTROL_CONNECTION,
  TRIAL_DAYS,
} from '../domain/control.constants';
import {
  PLAN_QUOTAS,
  normalizePlan,
  type BusinessAddOns,
} from '../domain/plans';
import { PlanUpgradeRequiredException } from '../domain/plan-upgrade.exception';
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

  /** Mes actual en formato YYYY-MM (zona Colombia, UTC-5). */
  private currentDocsPeriod(): string {
    return new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 7);
  }

  /** Suma créditos de documentos comprados en paquetes (no expiran). */
  async addDocCredits(id: string, docs: number): Promise<void> {
    if (docs <= 0) return;
    await this.businesses
      .updateOne({ _id: id }, { $inc: { docCredits: docs } })
      .exec();
  }

  /**
   * Consume un documento electrónico contra el cupo MENSUAL del plan; si el mes
   * ya se agotó, tira de los créditos comprados (que no expiran). Atómico y
   * seguro ante concurrencia; lanza 402 si no queda cupo. El contador mensual se
   * reinicia solo al cambiar de mes.
   */
  async consumeDocument(id: string, plan?: string | null): Promise<void> {
    const period = this.currentDocsPeriod();
    const base = PLAN_QUOTAS[normalizePlan(plan)].documentsPerMonth;

    // Reinicia el contador si cambió el mes (atómico e idempotente).
    await this.businesses
      .updateOne(
        { _id: id, docsPeriod: { $ne: period } },
        { $set: { docsPeriod: period, docsThisMonth: 0 } },
      )
      .exec();

    // 1) Consumir del cupo mensual del plan.
    const monthly = await this.businesses
      .findOneAndUpdate(
        { _id: id, docsThisMonth: { $lt: base } },
        { $inc: { docsThisMonth: 1 } },
      )
      .exec();
    if (monthly) return;

    // 2) Mes agotado → consumir un crédito comprado.
    const credit = await this.businesses
      .findOneAndUpdate(
        { _id: id, docCredits: { $gt: 0 } },
        { $inc: { docCredits: -1, docsThisMonth: 1 } },
      )
      .exec();
    if (credit) return;

    throw new PlanUpgradeRequiredException(
      `Alcanzaste el tope de ${base} documentos electrónicos de tu plan este mes. Compra un paquete de documentos o mejora tu plan.`,
      { reason: 'quota', quota: 'documents' },
    );
  }

  /** Uso de documentos del mes en curso (para el panel de facturación). */
  async documentUsage(
    id: string,
  ): Promise<{ used: number; base: number; credits: number; period: string }> {
    const period = this.currentDocsPeriod();
    const business = await this.findById(id);
    const base = PLAN_QUOTAS[normalizePlan(business?.plan)].documentsPerMonth;
    const used =
      business?.docsPeriod === period ? (business?.docsThisMonth ?? 0) : 0;
    return { used, base, credits: business?.docCredits ?? 0, period };
  }

  /**
   * Actualiza el plan, complementos y/o estado de una empresa. Lo usa el módulo
   * de facturación al aprobarse un pago (activar plan/complementos) o al agotar
   * los reintentos de cobro (suspender). Solo toca los campos provistos.
   */
  async updatePlan(
    id: string,
    patch: {
      plan?: BusinessPlan;
      addOns?: BusinessAddOns;
      status?: BusinessStatus;
    },
  ): Promise<BusinessDocument | null> {
    const set: Record<string, unknown> = {};
    if (patch.plan !== undefined) set.plan = patch.plan;
    if (patch.addOns !== undefined) set.addOns = patch.addOns;
    if (patch.status !== undefined) set.status = patch.status;
    if (Object.keys(set).length === 0) return this.findById(id);
    return this.businesses
      .findByIdAndUpdate(id, { $set: set }, { new: true })
      .exec();
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
