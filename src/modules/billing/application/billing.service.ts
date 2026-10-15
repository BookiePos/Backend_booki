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
import {
  PaymentMethod,
  PaymentMethodDocument,
} from '../infrastructure/schemas/payment-method.schema';
import {
  WompiCardSource,
  WompiClient,
  WompiTransaction,
} from '../infrastructure/wompi.client';
import { SubscribeDto } from './dto/subscribe.dto';
import { SavePaymentMethodDto } from './dto/save-payment-method.dto';
import {
  APPLY_LEASE_MS,
  APPLY_VERSION,
  BILLING_CYCLES,
  BillingCycle,
  MAX_CHARGE_RETRIES,
  PENDING_RECONCILE_AFTER_MS,
  PENDING_RECONCILE_LIMIT,
  RETRY_COOLDOWN_MS,
  WOMPI_CURRENCY,
  mapWompiStatus,
} from '../domain/billing.constants';

const DOCS_PACKAGE_PRICE = ADD_ONS.docPackage.price;

/**
 * Resultado que devuelve el frontend para hacer polling del estado del cobro,
 * consultando `GET /billing/payments/:reference` con esta `reference`.
 */
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
    @InjectModel(PaymentMethod.name, CONTROL_CONNECTION)
    private readonly paymentMethods: Model<PaymentMethodDocument>,
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
    personalDataAuthToken: string;
    personalDataPermalink: string;
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
        personalDataAuthToken: '',
        personalDataPermalink: '',
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
      personalDataAuthToken: acc.personalDataAuthToken,
      personalDataPermalink: acc.personalDataPermalink,
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

    // O llega una tarjeta nueva del widget, o se cobra contra la que la empresa
    // ya registró. Antes solo existía el primer camino: el token de Wompi es de
    // un solo uso, así que cada cambio de plan obligaba a escribir la tarjeta
    // otra vez aunque estuviera guardada.
    const paymentSourceId = dto.cardToken
      ? (await this.registerCard(businessId, email, dto.cardToken, dto)).id
      : await this.savedPaymentSourceId(businessId);

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

  /**
   * Registra la tarjeta SIN cobrar nada y la deja guardada para la empresa.
   *
   * Existe porque el token que devuelve el widget de Wompi es de un solo uso y
   * vive en la pestaña del navegador: mientras no se cambiara por una fuente de
   * pago en Wompi, la tarjeta "guardada" desaparecía al recargar la página.
   */
  async savePaymentMethod(
    businessId: string,
    dto: SavePaymentMethodDto,
  ): Promise<PaymentMethodDocument> {
    this.ensureConfigured();
    const business = await this.businesses.findById(businessId);
    if (!business) throw new NotFoundException('Empresa no encontrada');
    const email = dto.customerEmail ?? business.ownerEmail;
    await this.registerCard(businessId, email, dto.cardToken, dto);

    const saved = await this.paymentMethods.findOne({ businessId }).exec();
    // `registerCard` acaba de hacer el upsert, así que esto no puede faltar.
    return saved!;
  }

  /** Tarjeta guardada de una empresa, o `null` si nunca registró una. */
  async findPaymentMethod(businessId: string): Promise<PaymentMethodDocument | null> {
    return this.paymentMethods.findOne({ businessId }).exec();
  }

  /**
   * Resuelve AHORA el estado de un cobro preguntándole a Wompi, en vez de
   * esperar al webhook.
   *
   * Wompi responde `PENDING` al crear la transacción SIEMPRE —el cobro se
   * procesa asíncrono, también en sandbox— y la aprobación llega por webhook.
   * Cuando el webhook no llega (desarrollo local, un despliegue sin URL
   * pública, un evento perdido), el pago se quedaba pendiente hasta el barrido
   * del cron: seis horas mirando "pago en proceso" con la plata ya cobrada.
   * Esto le da al frontend una forma de cerrar el ciclo en segundos.
   */
  async syncPayment(
    businessId: string,
    reference: string,
  ): Promise<{ reference: string; status: string; applied: boolean }> {
    const payment = await this.payments
      .findOne({ businessId, reference })
      .exec();
    if (!payment) throw new NotFoundException('Pago no encontrado');

    if (
      this.wompi.configured &&
      payment.status === 'pending' &&
      payment.wompiTransactionId
    ) {
      try {
        const tx = await this.wompi.getTransaction(payment.wompiTransactionId);
        const status = this.verifiedStatus(payment, tx, payment.wompiTransactionId);
        if (status) await this.syncTransaction(payment, status);
      } catch (err) {
        // Consultar es un extra sobre el webhook: si la pasarela no responde se
        // devuelve lo que hay guardado y el cron reintenta más tarde.
        this.logger.error(
          `No se pudo consultar la transacción ${payment.wompiTransactionId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return {
      reference,
      status: payment.status,
      applied: payment.applied ?? false,
    };
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

    // La firma prueba que el evento salió de Wompi, no que siga siendo cierto:
    // un evento viejo reenviado dentro de la ventana, o uno de otra
    // transacción con la misma referencia, aplicaría un pago que no es. Se
    // pregunta a la API (fuente de verdad) y solo se aplica si todo coincide.
    const txId = payment.wompiTransactionId ?? tx.id;
    if (!txId || (tx.id && tx.id !== txId)) {
      this.logger.warn(
        `Evento de ${tx.reference} con transacción ${tx.id ?? '—'} distinta de la del pago: se ignora.`,
      );
      return { received: true };
    }
    // Si la API falla se deja propagar el error: sin un 200 Wompi reintenta.
    const real = await this.wompi.getTransaction(txId);
    const status = this.verifiedStatus(payment, real, txId);
    if (!status) return { received: true };
    if (status !== tx.status) {
      this.logger.warn(
        `Evento de ${payment.reference} dice ${tx.status} y la API ${status}: no se aplica.`,
      );
      return { received: true };
    }
    if (!payment.wompiTransactionId) {
      payment.wompiTransactionId = txId;
      await payment.save();
    }
    await this.syncTransaction(payment, status);
    return { received: true };
  }

  /**
   * Estado de la transacción según la API, SOLO si es la del pago: misma
   * transacción, referencia, moneda y monto. Si algo no coincide devuelve
   * `null` y no se aplica nada: un estado de otra transacción (o de un monto
   * menor) no puede activar ni suspender este pago.
   */
  private verifiedStatus(
    payment: PaymentDocument,
    real: WompiTransaction,
    txId: string,
  ): string | null {
    const coincide =
      real.id === txId &&
      real.reference === payment.reference &&
      real.currency === WOMPI_CURRENCY &&
      Number(real.amount_in_cents) === payment.amountInCents;
    if (!coincide) {
      this.logger.error(
        `Transacción ${txId} no coincide con el pago ${payment.reference} ` +
          `(id ${real.id}, monto ${real.amount_in_cents}/${payment.amountInCents}, ` +
          `moneda ${real.currency}, referencia ${real.reference}): no se aplica.`,
      );
      return null;
    }
    return real.status;
  }

  /** Estado de facturación de una empresa (para el panel). */
  async status(businessId: string): Promise<{
    subscription: SubscriptionDocument | null;
    paymentMethod: PaymentMethodDocument | null;
    payments: PaymentDocument[];
    documents: { used: number; base: number; credits: number; period: string };
  }> {
    const [subscription, paymentMethod, payments, documents] = await Promise.all([
      this.subs.findOne({ businessId }).exec(),
      this.paymentMethods.findOne({ businessId }).exec(),
      this.payments
        .find({ businessId })
        .sort({ createdAt: -1 })
        .limit(20)
        .exec(),
      this.businesses.documentUsage(businessId),
    ]);
    return { subscription, paymentMethod, payments, documents };
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
    /** `false` = no se hizo nada porque la pasarela no está configurada. */
    configured: boolean;
  }> {
    if (!this.wompi.configured) {
      return { charged: 0, suspended: 0, reconciled: 0, configured: false };
    }
    const now = new Date();
    let charged = 0;
    let suspended = 0;

    const reconciled =
      (await this.reconcilePending()) + (await this.resumeUnfinishedApprovals());

    const due = await this.subs
      .find({ status: 'active', nextChargeAt: { $lte: now } })
      .exec();
    for (const sub of due) {
      try {
        if (await this.chargeRenewal(sub, now)) charged++;
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
        if (await this.chargeRenewal(sub, now)) charged++;
      } catch (err) {
        this.logger.error(
          `Fallo reintentando cobro de ${sub.businessId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    suspended += await this.revokeEndedSubscriptions(now);

    return { charged, suspended, reconciled, configured: true };
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
      // Primero los que hace más tiempo no se consultan (nunca = primero): si
      // no, un centenar de pagos atascados acapararía el cupo cada día y los
      // nuevos no se revisarían nunca.
      .sort({ lastReconcileAt: 1, createdAt: 1 })
      .limit(PENDING_RECONCILE_LIMIT)
      .exec();

    let resueltos = 0;
    for (const payment of pendientes) {
      try {
        await this.payments
          .updateOne(
            { _id: payment._id },
            { $set: { lastReconcileAt: new Date() } },
          )
          .exec();
        const txId = payment.wompiTransactionId!;
        const tx = await this.wompi.getTransaction(txId);
        const status = this.verifiedStatus(payment, tx, txId);
        if (!status || mapWompiStatus(status) === 'pending') continue;
        await this.syncTransaction(payment, status);
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
   * Retoma los pagos aprobados cuyos efectos no terminaron (un fallo o un
   * proceso muerto a mitad de `applyApproved`). Sin esto quedaban cobrados y
   * sin servicio: el webhook y la consulta solo miran pagos pendientes.
   */
  private async resumeUnfinishedApprovals(): Promise<number> {
    const caducada = new Date(Date.now() - APPLY_LEASE_MS);
    const aMedias = await this.payments
      .find({
        status: 'approved',
        applied: { $ne: true },
        // Solo los que reservó este protocolo: uno aprobado por el código
        // anterior no dice qué efectos hizo y re-aplicarlo podría duplicarlos.
        applyVersion: APPLY_VERSION,
        $or: [{ applyingAt: null }, { applyingAt: { $lte: caducada } }],
      })
      .sort({ updatedAt: 1 })
      .limit(PENDING_RECONCILE_LIMIT)
      .exec();

    let retomados = 0;
    for (const payment of aMedias) {
      try {
        await this.applyApproved(payment);
        if (payment.applied) retomados++;
      } catch (err) {
        this.logger.error(
          `No se pudo completar el pago aprobado ${payment.reference}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return retomados;
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

  /**
   * Cobra una renovación (o su reintento en mora). Devuelve `false` si otro
   * barrido ya reservó este intento y aquí no se cobró nada.
   */
  private async chargeRenewal(
    sub: SubscriptionDocument,
    now: Date,
  ): Promise<boolean> {
    // Reserva atómica del intento. El cerrojo del scheduler es en memoria y por
    // instancia: dos llamadas a /cron/diario (Vercel puede entregar el evento
    // dos veces, o alguien pulsa «Run») leen la misma suscripción vencida. Solo
    // cobra quien logra cambiar `lastChargeAttemptAt` desde el valor que leyó.
    // De paso adelanta el próximo cobro de las activas (optimista: si declina,
    // syncTransaction la pasa a past_due y el reintento lo maneja el cooldown).
    const attemptAt = new Date();
    const filtro: Record<string, unknown> = {
      _id: sub._id,
      status: sub.status,
      lastChargeAttemptAt: sub.lastChargeAttemptAt ?? null,
    };
    const cambios: Record<string, unknown> = { lastChargeAttemptAt: attemptAt };
    if (sub.status === 'active') {
      filtro.nextChargeAt = { $lte: now };
      cambios.nextChargeAt = this.nextChargeFrom(sub);
    }
    const reserva = await this.subs.updateOne(filtro, { $set: cambios }).exec();
    if (reserva.modifiedCount !== 1) {
      this.logger.warn(
        `Cobro de ${sub.businessId} omitido: otro barrido ya lo reservó.`,
      );
      return false;
    }
    Object.assign(sub, cambios);

    // Segunda defensa: referencia determinista por día e intento. Si dos
    // procesos llegaran aquí con el mismo intento, el índice único de
    // `reference` hace fallar el segundo `payments.create` antes de llamar a
    // Wompi. Un reintento (otro `failedAttempts`) u otro día llevan otra.
    const dia = attemptAt.toISOString().slice(0, 10).replace(/-/g, '');
    const reference = `ren-${sub.businessId}-${dia}-${sub.failedAttempts ?? 0}`;

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
    return true;
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
    if (payment.applied || status === 'pending') return; // no degradar
    // Transición atómica desde `pending`: la copia en memoria puede estar
    // vieja (otro proceso ya lo aprobó) y un evento de rechazo repetido no
    // debe sumar otro intento fallido ni acelerar la cancelación.
    const transicion = await this.payments
      .findOneAndUpdate(
        { _id: payment._id, status: 'pending', applied: { $ne: true } },
        { $set: { status } },
        { new: true },
      )
      .exec();
    if (!transicion) return;
    payment.status = status;

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

  /**
   * Aplica los entitlements de un pago aprobado. Idempotente.
   *
   * Tres fases, porque el webhook, la consulta del frontend y el barrido
   * pueden llegar a la vez, cada uno con su copia en `applied: false`:
   *   1. RESERVA atómica (`applyingAt`, caduca a los `APPLY_LEASE_MS`): solo
   *      uno aplica; los demás salen sin tocar nada.
   *   2. EFECTOS por pasos (`effectsDone`): cada paso se anota al terminar,
   *      así que un reintento salta lo ya hecho (acreditar documentos o
   *      avanzar el período no son idempotentes por sí solos).
   *   3. CIERRE: `applied: true` solo cuando todo terminó. Si un efecto falla
   *      se libera la reserva y el error sube: el webhook responde 500 y Wompi
   *      reintenta, y si no, `resumeUnfinishedApprovals` lo retoma.
   * Queda una ventana: si el proceso muere entre un efecto y su anotación,
   * ese paso se repite al retomar. Es preferible a perderlo (cobrado sin
   * servicio) y exige una caída exactamente entre dos escrituras.
   */
  private async applyApproved(payment: PaymentDocument): Promise<void> {
    if (payment.applied) return;
    const ahora = new Date();
    const reservado = await this.payments
      .findOneAndUpdate(
        {
          _id: payment._id,
          applied: { $ne: true },
          $and: [
            {
              $or: [
                { applyingAt: null },
                {
                  applyingAt: {
                    $lte: new Date(ahora.getTime() - APPLY_LEASE_MS),
                  },
                },
              ],
            },
            // Un `approved` sin versión es del código anterior: no se toca.
            { $or: [{ status: { $ne: 'approved' } }, { applyVersion: APPLY_VERSION }] },
          ],
        },
        {
          $set: { status: 'approved', applyingAt: ahora, applyVersion: APPLY_VERSION },
        },
        { new: true },
      )
      .exec();
    payment.status = 'approved';
    if (!reservado) return; // otro proceso lo aplicó o lo está aplicando

    const hechos = new Set<string>(reservado.effectsDone ?? []);
    const paso = async (nombre: string, efecto: () => Promise<unknown>) => {
      if (hechos.has(nombre)) return;
      await efecto();
      await this.payments
        .updateOne({ _id: payment._id }, { $addToSet: { effectsDone: nombre } })
        .exec();
      hechos.add(nombre);
    };

    try {
      if (payment.kind === 'docPackage') {
        await paso('docCredits', () =>
          this.businesses.addDocCredits(
            payment.businessId,
            (payment.docPackages ?? 0) * DOCS_PER_PACKAGE,
            String(payment._id),
          ),
        );
      } else {
        // subscription | renewal → activa plan+complementos y avanza el período.
        await paso('plan', () =>
          this.businesses.updatePlan(payment.businessId, {
            plan: payment.plan as BusinessPlan,
            addOns: payment.addOns,
            status: 'active',
          }),
        );
        await paso('period', () => this.advancePeriod(payment));
      }
    } catch (err) {
      // Se suelta la reserva (solo si sigue siendo nuestra) para que el
      // reintento no espere a que caduque.
      await this.payments
        .updateOne(
          { _id: payment._id, applyingAt: ahora },
          { $set: { applyingAt: null } },
        )
        .exec()
        .catch(() => undefined);
      throw err;
    }

    await this.payments
      .updateOne(
        { _id: payment._id },
        { $set: { applied: true, applyingAt: null } },
      )
      .exec();
    payment.applied = true;
  }

  /** Deja la suscripción al día y abre el período que paga este cobro. */
  private async advancePeriod(payment: PaymentDocument): Promise<void> {
    const sub = await this.subs.findOne({ businessId: payment.businessId }).exec();
    if (!sub) return;
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

  /**
   * Cambia el token de un uso del widget por una fuente de pago permanente en
   * Wompi y la guarda como la tarjeta de la empresa.
   *
   * También apunta la suscripción existente a la tarjeta nueva: las
   * renovaciones se cobran contra `Subscription.paymentSourceId`, así que sin
   * esto quien cambiaba de tarjeta seguía viendo la nueva en pantalla mientras
   * el cron cobraba a la vieja.
   */
  private async registerCard(
    businessId: string,
    customerEmail: string,
    cardToken: string,
    acceptance: { acceptanceToken?: string; acceptPersonalAuth?: string },
  ): Promise<WompiCardSource> {
    if (!acceptance.acceptanceToken) {
      throw new BadRequestException(
        'Para registrar la tarjeta hay que aceptar los términos de Wompi.',
      );
    }
    const card = await this.wompi.createPaymentSource({
      token: cardToken,
      customerEmail,
      acceptanceToken: acceptance.acceptanceToken,
      acceptPersonalAuth: acceptance.acceptPersonalAuth,
    });

    await this.paymentMethods
      .updateOne(
        { businessId },
        {
          businessId,
          paymentSourceId: card.id,
          customerEmail,
          brand: card.brand ?? null,
          lastFour: card.lastFour ?? null,
        },
        { upsert: true, setDefaultsOnInsert: true },
      )
      .exec();

    await this.subs
      .updateOne({ businessId }, { paymentSourceId: card.id, customerEmail })
      .exec();

    return card;
  }

  /** Fuente de pago guardada de la empresa; falla claro si no hay tarjeta. */
  private async savedPaymentSourceId(businessId: string): Promise<number> {
    const saved = await this.paymentMethods.findOne({ businessId }).exec();
    if (!saved) {
      throw new BadRequestException(
        'No hay una tarjeta registrada. Agrega una antes de contratar el plan.',
      );
    }
    return saved.paymentSourceId;
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
