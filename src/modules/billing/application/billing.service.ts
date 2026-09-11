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
import { CONTROL_CONNECTION } from '../../control/domain/control.constants';
import {
  ADD_ONS,
  BUSINESS_PLANS,
  BusinessAddOns,
  BusinessPlan,
  CYCLE_MONTHS,
  CYCLE_BILLED_MONTHS,
  DOCS_PER_PACKAGE,
  effectiveEntitlements,
  planPrice,
  roundPrice,
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
  BILLING_CYCLES,
  BillingCycle,
  MAX_CHARGE_RETRIES,
  PENDING_RECONCILE_AFTER_MS,
  PENDING_RECONCILE_LIMIT,
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
    @InjectModel(Subscription.name, CONTROL_CONNECTION)
    private readonly subs: Model<SubscriptionDocument>,
    @InjectModel(Payment.name, CONTROL_CONNECTION)
    private readonly payments: Model<PaymentDocument>,
  ) {}

  /**
   * Catálogo de precios tal como los va a cobrar ESTE servidor: un renglón por
   * plan y ciclo, con los meses que cubre y el descuento por pagar por
   * adelantado.
   *
   * Se publica porque el frontend tenía su propia tabla de precios, y dos
   * tablas separadas se desincronizan: el cliente ve un número y se le cobra
   * otro. El que cobra es el que manda.
   */
  priceList(): {
    cycle: BillingCycle;
    months: number;
    plans: Record<BusinessPlan, number>;
    discountPercent: number;
  }[] {
    return BILLING_CYCLES.map((cycle) => ({
      cycle,
      months: CYCLE_MONTHS[cycle],
      plans: Object.fromEntries(
        BUSINESS_PLANS.map((plan) => [plan, planPrice(plan, cycle)]),
      ) as Record<BusinessPlan, number>,
      discountPercent: Math.round(
        (1 - CYCLE_BILLED_MONTHS[cycle] / CYCLE_MONTHS[cycle]) * 1000,
      ) / 10,
    }));
  }

  /** Datos que necesita el frontend para tokenizar la tarjeta con Wompi. */
  async config(): Promise<{
    publicKey: string;
    environment: string;
    acceptanceToken: string;
    permalink: string;
    configured: boolean;
    pricing: ReturnType<BillingService['priceList']>;
  }> {
    const pricing = this.priceList();
    if (!this.wompi.configured) {
      return {
        publicKey: '',
        environment: this.wompi.environment,
        acceptanceToken: '',
        permalink: '',
        configured: false,
        pricing,
      };
    }
    const acc = await this.wompi.getAcceptance();
    return {
      publicKey: this.wompi.publicKey,
      environment: this.wompi.environment,
      acceptanceToken: acc.acceptanceToken,
      permalink: acc.permalink,
      configured: true,
      pricing,
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
    const cycle: BillingCycle = (
      BILLING_CYCLES as readonly string[]
    ).includes(dto.billingCycle ?? '')
      ? (dto.billingCycle as BillingCycle)
      : 'monthly';
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
    // Sin llaves configuradas el secreto de eventos es la cadena vacía, así que
    // cualquiera que conozca el algoritmo puede firmar un evento y activarse el
    // plan: el webhook es público por necesidad. Se rechaza antes de validar.
    if (!this.wompi.configured) {
      this.logger.warn(
        'Evento de webhook recibido con la pasarela sin configurar: se descarta.',
      );
      throw new ForbiddenException('Firma de evento inválida');
    }
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
    documents: { used: number; base: number; credits: number; period: string };
  }> {
    const [subscription, payments, documents] = await Promise.all([
      this.subs.findOne({ businessId }).exec(),
      this.payments
        .find({ businessId })
        .sort({ createdAt: -1 })
        .limit(20)
        .exec(),
      this.businesses.documentUsage(businessId),
    ]);
    return { subscription, payments, documents };
  }

  /**
   * Cancela la suscripción: no se vuelve a cobrar, pero el servicio sigue hasta
   * el final del período YA PAGADO. Quien pagó el mes completo lo usa completo.
   *
   * Quien no tiene período pagado por delante (nunca llegó a aprobarse un cobro,
   * o ya venció) pierde el acceso en el acto. Del resto se encarga el barrido
   * cuando llegue la fecha; ver `revokeEndedSubscriptions`.
   */
  async cancel(businessId: string): Promise<SubscriptionDocument> {
    const sub = await this.subs.findOne({ businessId }).exec();
    if (!sub) throw new NotFoundException('No hay suscripción activa');
    sub.status = 'canceled';
    sub.canceledAt = new Date();
    sub.nextChargeAt = undefined;
    const pagadoHasta = sub.currentPeriodEnd?.getTime() ?? 0;
    if (pagadoHasta <= Date.now()) {
      await this.revokeAccess(sub);
    }
    await sub.save();
    return sub;
  }

  /** Suspende la empresa y deja constancia de cuándo se le retiró el acceso. */
  private async revokeAccess(sub: SubscriptionDocument): Promise<void> {
    if (sub.accessEndedAt) return; // idempotente: no se suspende dos veces
    sub.accessEndedAt = new Date();
    await this.businesses.updatePlan(sub.businessId, { status: 'suspended' });
  }

  // ── Cron (lo dispara el scheduler) ──────────────────────────────────────────

  /**
   * Barrido de facturación. Hace cuatro cosas, en este orden:
   *
   *   1. Resuelve los cobros que quedaron pendientes (webhook perdido).
   *   2. Cobra las renovaciones vencidas.
   *   3. Reintenta las que están en mora y suspende al agotar los intentos.
   *   4. Retira el acceso a quien canceló y ya consumió lo que pagó.
   */
  async runBillingCycle(): Promise<{
    charged: number;
    suspended: number;
    reconciled: number;
  }> {
    if (!this.wompi.configured) {
      return { charged: 0, suspended: 0, reconciled: 0 };
    }
    const now = new Date();
    let charged = 0;
    let suspended = 0;

    const reconciled = await this.reconcilePending();

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
        // Aquí no hay período pagado que respetar: el cobro falló. Se corta el
        // acceso en el acto, y `revokeAccess` deja la marca para que el barrido
        // de canceladas no vuelva a tomar esta suscripción.
        sub.status = 'canceled';
        sub.canceledAt = now;
        await this.revokeAccess(sub);
        await sub.save();
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

    suspended += await this.revokeEndedSubscriptions(now);

    return { charged, suspended, reconciled };
  }

  /**
   * Pregunta a la pasarela por los cobros que siguen "pendientes" pasado un
   * rato y aplica el estado real.
   *
   * El webhook resuelve en segundos cuando llega; cuando se pierde —y se
   * pierde— el pago se quedaba pendiente para siempre: ni se activaba el plan
   * de quien ya había pagado, ni se volvía a intentar el cobro. Nadie se entera
   * porque no hay error en ningún lado, simplemente no pasa nada.
   */
  private async reconcilePending(): Promise<number> {
    const limite = new Date(Date.now() - PENDING_RECONCILE_AFTER_MS);
    const pendientes = await this.payments
      .find({
        status: 'pending',
        wompiTransactionId: { $ne: null },
        createdAt: { $lte: limite },
      })
      .sort({ createdAt: 1 })
      .limit(PENDING_RECONCILE_LIMIT)
      .exec();

    let resueltos = 0;
    for (const payment of pendientes) {
      try {
        const tx = await this.wompi.getTransaction(payment.wompiTransactionId!);
        if (mapWompiStatus(tx.status) === 'pending') continue;
        await this.syncTransaction(payment, tx.status);
        resueltos++;
      } catch (err) {
        this.logger.error(
          `No se pudo consultar la transacción ${payment.wompiTransactionId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return resueltos;
  }

  /**
   * Retira el acceso a las suscripciones canceladas cuyo período pagado ya
   * venció. Cancelar no corta en el acto: el servicio dura hasta donde se pagó.
   */
  private async revokeEndedSubscriptions(now: Date): Promise<number> {
    const vencidas = await this.subs
      .find({
        status: 'canceled',
        accessEndedAt: null,
        currentPeriodEnd: { $lte: now },
      })
      .exec();

    let retirados = 0;
    for (const sub of vencidas) {
      try {
        await this.revokeAccess(sub);
        await sub.save();
        retirados++;
      } catch (err) {
        this.logger.error(
          `No se pudo retirar el acceso de ${sub.businessId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return retirados;
  }

  private async chargeRenewal(sub: SubscriptionDocument): Promise<void> {
    const reference = `ren-${sub.businessId}-${Date.now()}`;
    // Optimista: adelanta el próximo cobro para no re-cobrar en el siguiente
    // barrido antes de que resuelva el webhook. Si declina, syncTransaction lo
    // pasa a past_due y el reintento lo maneja el cooldown.
    sub.lastChargeAttemptAt = new Date();
    if (sub.status === 'active') {
      sub.nextChargeAt = this.nextChargeFrom(sub);
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
      await this.businesses.addDocCredits(
        payment.businessId,
        (payment.docPackages ?? 0) * DOCS_PER_PACKAGE,
      );
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

  /**
   * Monto recurrente en centavos: plan del ciclo + complementos.
   *
   * Los complementos llevan el MISMO descuento del ciclo que el plan (se cobran
   * los meses facturables, no los cubiertos): quien paga por adelantado lo hace
   * por todo lo que contrató, no solo por una parte.
   */
  private recurringAmountCents(
    plan: BusinessPlan,
    cycle: BillingCycle,
    addOns: BusinessAddOns,
  ): number {
    let addOnMonthly = 0;
    if (addOns.payroll) addOnMonthly += ADD_ONS.payroll.price;
    if (addOns.extraSedes) addOnMonthly += addOns.extraSedes * ADD_ONS.extraSede.price;
    if (addOns.extraEmployees) {
      addOnMonthly += addOns.extraEmployees * ADD_ONS.extraEmployee.price;
    }
    const addOnTotal = roundPrice(addOnMonthly * CYCLE_BILLED_MONTHS[cycle]);
    return (planPrice(plan, cycle) + addOnTotal) * 100;
  }

  /**
   * Avanza la fecha los meses del ciclo CONSERVANDO el día de cobro.
   *
   * Sumar meses sobre el día 31 se desborda al mes siguiente (31 de enero + 1
   * mes = 3 de marzo), de modo que quien se suscribía a fin de mes se saltaba
   * febrero entero y recibía un mes de servicio sin pagar. Se ancla el día 1
   * para mover el mes sin desbordar y después se recorta al último día del mes
   * destino: el 31 de enero pasa al 28 de febrero y vuelve al 31 en marzo.
   */
  private advance(from: Date, cycle: BillingCycle): Date {
    const day = from.getDate();
    const d = new Date(from);
    d.setDate(1);
    d.setMonth(d.getMonth() + CYCLE_MONTHS[cycle]);
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, lastDay));
    return d;
  }

  /**
   * Próximo cobro a partir del anterior, para no perder el día de aniversario
   * si un barrido corre tarde. Nunca queda en el pasado: si se saltaron varios
   * períodos, avanza hasta el primero que esté por venir.
   */
  private nextChargeFrom(sub: SubscriptionDocument): Date {
    const cycle = sub.billingCycle as BillingCycle;
    const now = Date.now();
    let next = this.advance(sub.nextChargeAt ?? new Date(), cycle);
    while (next.getTime() <= now) {
      next = this.advance(next, cycle);
    }
    return next;
  }

  /** Entitlements efectivos de una empresa (para mostrar en el panel). */
  entitlementsFor(plan?: string | null, addOns?: BusinessAddOns) {
    return effectiveEntitlements(plan, addOns);
  }
}
