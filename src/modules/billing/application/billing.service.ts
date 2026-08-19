import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BusinessService } from '../../control/application/business.service';
import {
  ADD_ONS,
  BUSINESS_PLANS,
  BusinessAddOns,
  BusinessPlan,
  PLAN_PRICING,
  effectiveEntitlements,
} from '../../control/domain/plans';
import {
  Subscription,
  SubscriptionDocument,
} from '../infrastructure/schemas/subscription.schema';
import {
  Payment,
  PaymentDocument,
} from '../infrastructure/schemas/payment.schema';
import { WompiClient } from '../infrastructure/wompi.client';
import { SubscribeDto } from './dto/subscribe.dto';
import {
  BillingCycle,
  MAX_CHARGE_RETRIES,
  RETRY_COOLDOWN_MS,
  mapWompiStatus,
} from '../domain/billing.constants';

const DOCS_PACKAGE_PRICE = ADD_ONS.docPackage.price;

/** Resultado que devuelve el frontend para hacer polling del estado del cobro. */
export interface ChargeResult {
  reference: string;
  transactionId: string;
  status: string;
}

/**
 * Facturación/suscripciones con Wompi (tokenizado recurrente). Vive en el
 * control-plane: opera sobre `businesses`, `subscriptions` y `billing_payments`
 * sin contexto de tenant. La activación de entitlements es idempotente
 * (`Payment.applied`) para tolerar webhooks repetidos.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly businesses: BusinessService,
    private readonly wompi: WompiClient,
    @InjectModel(Subscription.name)
    private readonly subs: Model<SubscriptionDocument>,
    @InjectModel(Payment.name)
    private readonly payments: Model<PaymentDocument>,
  ) {}

  /** Datos que necesita el frontend para tokenizar la tarjeta con Wompi. */
  async config(): Promise<{
    publicKey: string;
    environment: string;
    acceptanceToken: string;
    permalink: string;
    configured: boolean;
  }> {
    if (!this.wompi.configured) {
      return {
        publicKey: '',
        environment: this.wompi.environment,
        acceptanceToken: '',
        permalink: '',
        configured: false,
      };
    }
    const acc = await this.wompi.getAcceptance();
    return {
      publicKey: this.wompi.publicKey,
      environment: this.wompi.environment,
      acceptanceToken: acc.acceptanceToken,
      permalink: acc.permalink,
      configured: true,
    };
  }

  /** Alta o cambio de suscripción: crea fuente de pago y cobra el primer período. */
  async subscribe(businessId: string, dto: SubscribeDto): Promise<ChargeResult> {
    this.ensureConfigured();
    const business = await this.businesses.findById(businessId);
    if (!business) throw new NotFoundException('Empresa no encontrada');

    const plan = dto.plan as BusinessPlan;
    if (!(BUSINESS_PLANS as readonly string[]).includes(plan)) {
      throw new BadRequestException('Plan no válido');
    }
    const cycle: BillingCycle = dto.billingCycle === 'annual' ? 'annual' : 'monthly';
    const addOns = this.sanitizeAddOns(dto.addOns);
    const email = dto.customerEmail ?? business.ownerEmail;

    const paymentSourceId = await this.wompi.createPaymentSource({
      token: dto.cardToken,
      customerEmail: email,
      acceptanceToken: dto.acceptanceToken,
    });

    const amountInCents = this.recurringAmountCents(plan, cycle, addOns);
    const reference = `sub-${businessId}-${Date.now()}`;

    const sub = await this.subs.findOneAndUpdate(
      { businessId },
      {
        businessId,
        plan,
        billingCycle: cycle,
        addOns,
        paymentSourceId,
        customerEmail: email,
        amountInCents,
        status: 'pending',
        lastChargeAttemptAt: new Date(),
        failedAttempts: 0,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    const payment = await this.payments.create({
      businessId,
      subscriptionId: sub._id.toString(),
      reference,
      kind: 'subscription',
      amountInCents,
      status: 'pending',
      plan,
      addOns,
    });

    const tx = await this.wompi.createTransaction({
      amountInCents,
      reference,
      customerEmail: email,
      paymentSourceId,
    });
    payment.wompiTransactionId = tx.id;
    await payment.save();

    // El sandbox suele resolver síncrono; en prod llega por webhook.
    await this.syncTransaction(payment, tx.status);

    return { reference, transactionId: tx.id, status: tx.status };
  }

  /** Compra única de paquetes de documentos contra la tarjeta ya guardada. */
  async purchaseDocs(businessId: string, packages: number): Promise<ChargeResult> {
    this.ensureConfigured();
    const sub = await this.subs.findOne({ businessId }).exec();
    if (!sub || sub.status === 'canceled') {
      throw new BadRequestException(
        'Necesitas una suscripción activa con tarjeta registrada para comprar documentos.',
      );
    }
    const amountInCents = DOCS_PACKAGE_PRICE * packages * 100;
    const reference = `doc-${businessId}-${Date.now()}`;
    const payment = await this.payments.create({
      businessId,
      subscriptionId: sub._id.toString(),
      reference,
      kind: 'docPackage',
      amountInCents,
      status: 'pending',
      docPackages: packages,
    });
    const tx = await this.wompi.createTransaction({
      amountInCents,
      reference,
      customerEmail: sub.customerEmail,
      paymentSourceId: sub.paymentSourceId,
    });
    payment.wompiTransactionId = tx.id;
    await payment.save();
    await this.syncTransaction(payment, tx.status);
    return { reference, transactionId: tx.id, status: tx.status };
  }

  /** Procesa un evento del webhook de Wompi (`transaction.updated`). */
  async handleWebhook(event: {
    event?: string;
    data?: { transaction?: { id?: string; reference?: string; status?: string } };
    timestamp?: number;
    signature?: { checksum?: string; properties?: string[] };
  }): Promise<{ received: boolean }> {
    if (!this.wompi.verifyEvent(event)) {
      throw new ForbiddenException('Firma de evento inválida');
    }
    if (event.event !== 'transaction.updated') {
      return { received: true };
    }
    const tx = event.data?.transaction;
    if (!tx?.reference || !tx.status) return { received: true };

    const payment = await this.payments.findOne({ reference: tx.reference }).exec();
    if (!payment) return { received: true };
    if (!payment.wompiTransactionId && tx.id) {
      payment.wompiTransactionId = tx.id;
      await payment.save();
    }
    await this.syncTransaction(payment, tx.status);
    return { received: true };
  }

  /** Estado de facturación de una empresa (para el panel). */
  async status(businessId: string): Promise<{
    subscription: SubscriptionDocument | null;
    payments: PaymentDocument[];
  }> {
    const [subscription, payments] = await Promise.all([
      this.subs.findOne({ businessId }).exec(),
      this.payments
        .find({ businessId })
        .sort({ createdAt: -1 })
        .limit(20)
        .exec(),
    ]);
    return { subscription, payments };
  }

  /** Cancela la suscripción al final del período (no se renueva). */
  async cancel(businessId: string): Promise<SubscriptionDocument> {
    const sub = await this.subs.findOne({ businessId }).exec();
    if (!sub) throw new NotFoundException('No hay suscripción activa');
    sub.status = 'canceled';
    sub.canceledAt = new Date();
    sub.nextChargeAt = undefined;
    await sub.save();
    return sub;
  }

  // ── Cron (lo dispara el scheduler) ──────────────────────────────────────────

  /** Cobra renovaciones vencidas y gestiona los reintentos/suspensión (dunning). */
  async runBillingCycle(): Promise<{ charged: number; suspended: number }> {
    if (!this.wompi.configured) return { charged: 0, suspended: 0 };
    const now = new Date();
    let charged = 0;
    let suspended = 0;

    const due = await this.subs
      .find({ status: 'active', nextChargeAt: { $lte: now } })
      .exec();
    for (const sub of due) {
      try {
        await this.chargeRenewal(sub);
        charged++;
      } catch (err) {
        this.logger.error(
          `Fallo cobrando renovación de ${sub.businessId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    const pastDue = await this.subs.find({ status: 'past_due' }).exec();
    for (const sub of pastDue) {
      if ((sub.failedAttempts ?? 0) >= MAX_CHARGE_RETRIES) {
        sub.status = 'canceled';
        sub.canceledAt = now;
        await sub.save();
        await this.businesses.updatePlan(sub.businessId, { status: 'suspended' });
        suspended++;
        continue;
      }
      const last = sub.lastChargeAttemptAt?.getTime() ?? 0;
      if (now.getTime() - last < RETRY_COOLDOWN_MS) continue;
      try {
        await this.chargeRenewal(sub);
        charged++;
      } catch (err) {
        this.logger.error(
          `Fallo reintentando cobro de ${sub.businessId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return { charged, suspended };
  }

  private async chargeRenewal(sub: SubscriptionDocument): Promise<void> {
    const reference = `ren-${sub.businessId}-${Date.now()}`;
    // Optimista: adelanta el próximo cobro para no re-cobrar en el siguiente
    // barrido antes de que resuelva el webhook. Si declina, syncTransaction lo
    // pasa a past_due y el reintento lo maneja el cooldown.
    sub.lastChargeAttemptAt = new Date();
    if (sub.status === 'active') {
      sub.nextChargeAt = this.advance(new Date(), sub.billingCycle as BillingCycle);
    }
    await sub.save();

    const payment = await this.payments.create({
      businessId: sub.businessId,
      subscriptionId: sub._id.toString(),
      reference,
      kind: 'renewal',
      amountInCents: sub.amountInCents,
      status: 'pending',
      plan: sub.plan,
      addOns: sub.addOns,
    });
    const tx = await this.wompi.createTransaction({
      amountInCents: sub.amountInCents,
      reference,
      customerEmail: sub.customerEmail,
      paymentSourceId: sub.paymentSourceId,
    });
    payment.wompiTransactionId = tx.id;
    await payment.save();
    await this.syncTransaction(payment, tx.status);
  }

  // ── Internos ────────────────────────────────────────────────────────────────

  /** Refleja el estado de una transacción Wompi en el pago y aplica efectos. */
  private async syncTransaction(
    payment: PaymentDocument,
    wompiStatus: string,
  ): Promise<void> {
    const status = mapWompiStatus(wompiStatus);
    if (status === 'approved') {
      await this.applyApproved(payment);
      return;
    }
    if (payment.applied) return; // ya se aplicó antes; no degradar
    payment.status = status;
    await payment.save();

    if (status === 'declined' || status === 'error' || status === 'voided') {
      const sub = await this.subs.findOne({ businessId: payment.businessId }).exec();
      if (!sub) return;
      if (payment.kind === 'renewal') {
        sub.status = 'past_due';
        sub.failedAttempts = (sub.failedAttempts ?? 0) + 1;
        await sub.save();
      } else if (payment.kind === 'subscription' && sub.status === 'pending') {
        // El alta falló: la suscripción queda pendiente (el dueño puede reintentar).
        sub.failedAttempts = (sub.failedAttempts ?? 0) + 1;
        await sub.save();
      }
    }
  }

  /** Aplica los entitlements de un pago aprobado. Idempotente. */
  private async applyApproved(payment: PaymentDocument): Promise<void> {
    if (payment.applied) return;
    payment.status = 'approved';
    payment.applied = true;
    await payment.save();

    if (payment.kind === 'docPackage') {
      const business = await this.businesses.findById(payment.businessId);
      const current = business?.addOns?.docPackages ?? 0;
      await this.businesses.updatePlan(payment.businessId, {
        addOns: {
          ...(business?.addOns ?? {}),
          docPackages: current + (payment.docPackages ?? 0),
        },
      });
      return;
    }

    // subscription | renewal → activa plan+complementos y avanza el período.
    await this.businesses.updatePlan(payment.businessId, {
      plan: payment.plan as BusinessPlan,
      addOns: payment.addOns,
      status: 'active',
    });

    const sub = await this.subs.findOne({ businessId: payment.businessId }).exec();
    if (sub) {
      const from =
        sub.currentPeriodEnd && sub.currentPeriodEnd > new Date()
          ? sub.currentPeriodEnd
          : new Date();
      const end = this.advance(from, sub.billingCycle as BillingCycle);
      sub.status = 'active';
      sub.currentPeriodEnd = end;
      sub.nextChargeAt = end;
      sub.failedAttempts = 0;
      sub.lastTransactionId = payment.wompiTransactionId;
      await sub.save();
    }
  }

  private ensureConfigured(): void {
    if (!this.wompi.configured) {
      throw new BadRequestException(
        'La pasarela de pagos no está configurada. Faltan las llaves de Wompi.',
      );
    }
  }

  /** Normaliza los complementos recurrentes recibidos del DTO. */
  private sanitizeAddOns(input?: {
    payroll?: boolean;
    extraSedes?: number;
    extraEmployees?: number;
  }): BusinessAddOns {
    const addOns: BusinessAddOns = {};
    if (input?.payroll) addOns.payroll = true;
    if (input?.extraSedes && input.extraSedes > 0) addOns.extraSedes = input.extraSedes;
    if (input?.extraEmployees && input.extraEmployees > 0) {
      addOns.extraEmployees = input.extraEmployees;
    }
    return addOns;
  }

  /** Monto recurrente en centavos: plan del ciclo + complementos prorrateados. */
  private recurringAmountCents(
    plan: BusinessPlan,
    cycle: BillingCycle,
    addOns: BusinessAddOns,
  ): number {
    const planPrice =
      cycle === 'annual' ? PLAN_PRICING[plan].annual : PLAN_PRICING[plan].monthly;
    const months = cycle === 'annual' ? 12 : 1;
    let addOnMonthly = 0;
    if (addOns.payroll) addOnMonthly += ADD_ONS.payroll.price;
    if (addOns.extraSedes) addOnMonthly += addOns.extraSedes * ADD_ONS.extraSede.price;
    if (addOns.extraEmployees) {
      addOnMonthly += addOns.extraEmployees * ADD_ONS.extraEmployee.price;
    }
    return (planPrice + addOnMonthly * months) * 100;
  }

  private advance(from: Date, cycle: BillingCycle): Date {
    const d = new Date(from);
    if (cycle === 'annual') d.setFullYear(d.getFullYear() + 1);
    else d.setMonth(d.getMonth() + 1);
    return d;
  }

  /** Entitlements efectivos de una empresa (para mostrar en el panel). */
  entitlementsFor(plan?: string | null, addOns?: BusinessAddOns) {
    return effectiveEntitlements(plan, addOns);
  }
}
