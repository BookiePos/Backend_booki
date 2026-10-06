import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  EinvoicingAccount,
  EinvoicingAccountDocument,
} from '../infrastructure/schemas/einvoicing-account.schema';
import { SedesService } from '../../sedes/application/sedes.service';
import { SedeDocument } from '../../sedes/infrastructure/schemas/sede.schema';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import {
  allowedSedeIds,
  assertSedeAccess,
} from '../../core-auth/domain/sede-access';
import { SecretBox } from '../../../shared/crypto/secret-box';
import {
  EINVOICE_PROVIDER,
  EinvoiceProvider,
  NumberingRange,
} from './einvoice-provider';
import {
  CREDIT_NOTE_PREFIX,
  CREDIT_NOTE_RANGE,
  EinvoiceEnvironmentName,
} from '../domain/einvoicing.constants';
import { DIAN_HABILITACION_RESOLUTION } from '../domain/apidian-catalogs';
import {
  buildTestInvoices,
  buildTestNote,
  summarizeTestSet,
  TEST_NOTE_PREFIX,
  type TestSetDoc,
} from '../domain/test-set';
import type { EinvoiceDocument } from '../domain/einvoice-document';
import type { SendOutcome } from '../domain/send-outcome';

/** Lo que el servicio de emisión necesita para hablar con el facturador. */
export interface EinvoiceConnection {
  provider: EinvoiceProvider;
  /** Token de la empresa; ausente con el proveedor simulado. */
  token?: string;
  environment: EinvoiceEnvironmentName;
}

/** Estado del set de pruebas para el asistente. */
export interface TestSetView {
  sentAt?: Date;
  docs: TestSetDoc[];
  summary: ReturnType<typeof summarizeTestSet>;
}

/** Vista de una conexión para el asistente: nunca incluye el token. */
export interface AccountView {
  nit: string;
  dv?: string;
  sedes: { id: string; code: string; name: string }[];
  step: string;
  environment: EinvoiceEnvironmentName;
  softwareId?: string;
  hasTestSet: boolean;
  certificateExpiresAt?: Date;
  lastError?: string;
  connected: boolean;
  testSet: TestSetView;
}

/** Documento del set en la forma en que se guarda. */
function toEntry({ errors, ...rest }: TestSetDoc) {
  return { ...rest, dianErrors: errors };
}

/** Fecha y hora en Colombia (UTC-5, sin horario de verano). */
function colombiaNow(): { issueDate: string; issueTime: string } {
  const shifted = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
  return { issueDate: shifted.slice(0, 10), issueTime: shifted.slice(11, 19) };
}

/** NIT sin DV, puntos ni espacios: "900.123.456-7" → "900123456". */
export function normalizeNit(raw: string | undefined): string {
  return ((raw ?? '').split('-')[0] ?? '').replace(/\D/g, '');
}

/**
 * La conexión de cada NIT con el facturador (APIDIAN): crearla, cargarle el
 * certificado y el software, y pasarla a producción.
 *
 * Es la parte delicada de la facturación electrónica: aquí se decide con qué
 * certificado firma la empresa. Por eso:
 * - el token de la empresa se guarda cifrado y nunca sale de este servicio;
 * - el certificado (.p12) y su clave pasan directo al facturador y NO se
 *   guardan en BookiPos;
 * - todo exige el permiso `einvoicing.configure` y acceso a una sede del NIT.
 */
@Injectable()
export class EinvoicingAccountsService {
  private readonly logger = new Logger(EinvoicingAccountsService.name);
  private readonly secret: string;
  private boxCache?: SecretBox;

  constructor(
    @InjectModel(EinvoicingAccount.name)
    private readonly accounts: Model<EinvoicingAccountDocument>,
    @Inject(EINVOICE_PROVIDER) private readonly provider: EinvoiceProvider,
    private readonly sedes: SedesService,
    config: ConfigService,
  ) {
    this.secret = config.get<string>('EINVOICING_SECRET_KEY') ?? '';
  }

  private box(): SecretBox {
    if (!this.boxCache) {
      if (!this.secret) {
        throw new ServiceUnavailableException(
          'Falta EINVOICING_SECRET_KEY en el servidor: no se pueden guardar credenciales de facturación.',
        );
      }
      this.boxCache = new SecretBox(this.secret);
    }
    return this.boxCache;
  }

  /**
   * Descifra el token de la empresa. Si no se puede (casi siempre porque
   * cambió o se perdió EINVOICING_SECRET_KEY), lo dice con claridad en vez de
   * un "error interno": la única salida es volver a conectar la empresa.
   */
  private openToken(account: EinvoicingAccountDocument): string {
    try {
      return this.box().open(account.tokenSealed ?? '');
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      this.logger.error(
        `No se pudo descifrar el token del NIT ${account.nit}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new ServiceUnavailableException(
        `La conexión del NIT ${account.nit} con la DIAN no se puede leer (¿cambió la llave EINVOICING_SECRET_KEY del servidor?). Hay que volver a crear la empresa en Facturación > Conexión DIAN.`,
      );
    }
  }

  private assertProviderEnabled(): void {
    if (!this.provider.enabled) {
      throw new ServiceUnavailableException(
        'El servidor de facturación electrónica no está configurado (APIDIAN_URL).',
      );
    }
  }

  // ── Para la emisión ─────────────────────────────────────────────────────────

  /**
   * Con qué credenciales se emite para un NIT. `undefined` si el proveedor
   * exige habilitación y el NIT no la tiene: el llamador debe frenar ANTES de
   * quemar un consecutivo.
   */
  async connectionFor(rawNit: string | undefined): Promise<EinvoiceConnection | undefined> {
    if (!this.provider.requiresAccount) {
      return { provider: this.provider, environment: 'habilitacion' };
    }
    if (!this.provider.enabled) return undefined;
    const nit = normalizeNit(rawNit);
    if (!nit) return undefined;
    const account = await this.accounts.findOne({ nit }).exec();
    // Solo se emite con la empresa, el certificado y el software ya cargados:
    // antes de eso el facturador no tiene con qué firmar ni a dónde enviar.
    const ready = account?.step === 'set_pruebas' || account?.step === 'produccion';
    if (!account?.tokenSealed || !ready) return undefined;
    return {
      provider: this.provider,
      token: this.openToken(account),
      environment: account.environment,
    };
  }

  // ── Consulta ────────────────────────────────────────────────────────────────

  /** Conexiones de los NIT de las sedes que el usuario ve. */
  async list(user: JwtUser): Promise<AccountView[]> {
    const sedes = await this.sedes.list(allowedSedeIds(user));
    const byNit = new Map<string, SedeDocument[]>();
    for (const s of sedes) {
      const nit = normalizeNit(s.nit);
      if (!nit) continue;
      byNit.set(nit, [...(byNit.get(nit) ?? []), s]);
    }
    const accounts = await this.accounts
      .find({ nit: { $in: [...byNit.keys()] } })
      .exec();
    const byAccount = new Map(accounts.map((a) => [a.nit, a]));
    return [...byNit.entries()].map(([nit, list]) => {
      const a = byAccount.get(nit);
      return {
        nit,
        dv: a?.dv ?? list[0]?.nitDv,
        sedes: list.map((s) => ({ id: s.id as string, code: s.code, name: s.name })),
        step: a?.step ?? 'empresa',
        environment: a?.environment ?? 'habilitacion',
        softwareId: a?.softwareId,
        hasTestSet: Boolean(a?.testSetId),
        certificateExpiresAt: a?.certificateExpiresAt,
        lastError: a?.lastError,
        connected: Boolean(a?.tokenSealed),
        testSet: this.testSetView(a),
      };
    });
  }

  // ── Habilitación ──────────────────────────────────────────────────────────

  /** Sedes del NIT a las que el usuario tiene acceso; 403 si ninguna. */
  private async sedesOfNit(nit: string, user: JwtUser): Promise<SedeDocument[]> {
    const sedes = await this.sedes.list(allowedSedeIds(user));
    const mine = sedes.filter((s) => normalizeNit(s.nit) === nit);
    if (mine.length === 0) {
      throw new ForbiddenException('No tienes acceso a ninguna sede con ese NIT.');
    }
    return mine;
  }

  private async accountOrFail(nit: string): Promise<EinvoicingAccountDocument> {
    const a = await this.accounts.findOne({ nit }).exec();
    if (!a?.tokenSealed) {
      throw new NotFoundException(
        'Este NIT todavía no está conectado: primero crea la empresa en el facturador.',
      );
    }
    return a;
  }

  /**
   * Ejecuta un paso contra el facturador y deja el error guardado si falla, para
   * que el asistente muestre por qué no avanzó.
   */
  private async step<T>(
    account: EinvoicingAccountDocument | null,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      const out = await fn();
      if (account) account.lastError = undefined;
      return out;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (account) {
        account.lastError = msg;
        await account.save();
      }
      throw new BadRequestException(msg);
    }
  }

  /** Paso 1: crea (o actualiza) la empresa con los datos fiscales de la sede. */
  async registerCompany(sedeId: string, user: JwtUser): Promise<AccountView[]> {
    this.assertProviderEnabled();
    assertSedeAccess(user, sedeId);
    // Antes de crear nada: sin llave, el token que devuelva el facturador no
    // se podría guardar y la empresa quedaría creada allá sin forma de usarla.
    const box = this.box();
    const sede = await this.sedes.findOrFail(sedeId);
    const nit = normalizeNit(sede.nit);
    if (!nit) {
      throw new BadRequestException('La sede no tiene NIT registrado.');
    }
    const existing = await this.accounts.findOne({ nit }).exec();
    const { token } = await this.step(existing, () =>
      this.provider.configureCompany({
        nit,
        dv: sede.nitDv,
        businessName: sede.businessName || sede.name,
        tipoPersona: sede.tipoPersona,
        responsabilidadFiscal: sede.responsabilidadFiscal,
        address: sede.address ?? '',
        phone: sede.phone ?? '',
        email: sede.emailFacturacion ?? '',
        departamento: sede.departamento,
        ciudad: sede.ciudad,
      }),
    );
    await this.accounts
      .findOneAndUpdate(
        { nit },
        {
          $set: {
            dv: sede.nitDv,
            tokenSealed: box.seal(token),
            lastError: undefined,
            updatedByEmail: user.email,
          },
          // Solo avanza si es nueva: re-crear la empresa (p. ej. tras cambiar
          // la dirección) no debe devolver la habilitación al principio.
          $setOnInsert: { step: 'certificado', environment: 'habilitacion' },
        },
        { upsert: true },
      )
      .exec();
    if (existing?.step === 'empresa') {
      await this.accounts.updateOne({ nit }, { $set: { step: 'certificado' } }).exec();
    }
    this.logger.log(`Empresa ${nit} conectada al facturador por ${user.email}.`);
    return this.list(user);
  }

  /** Paso 2: certificado digital. Se pasa al facturador y no se guarda aquí. */
  async uploadCertificate(
    nit: string,
    certificateBase64: string,
    password: string,
    user: JwtUser,
  ): Promise<AccountView[]> {
    this.assertProviderEnabled();
    await this.sedesOfNit(nit, user);
    const account = await this.accountOrFail(nit);
    const token = this.openToken(account);
    const { expiresAt } = await this.step(account, () =>
      this.provider.configureCertificate(token, certificateBase64, password),
    );
    account.certificateExpiresAt = expiresAt ? new Date(expiresAt) : undefined;
    if (account.step === 'certificado') account.step = 'software';
    account.updatedByEmail = user.email;
    await account.save();
    this.logger.log(`Certificado de ${nit} cargado por ${user.email}.`);
    return this.list(user);
  }

  /** Paso 3: software propio (ID y PIN de la DIAN) y set de pruebas. */
  async configureSoftware(
    nit: string,
    input: { softwareId: string; pin: string; testSetId?: string },
    user: JwtUser,
  ): Promise<AccountView[]> {
    this.assertProviderEnabled();
    await this.sedesOfNit(nit, user);
    const account = await this.accountOrFail(nit);
    const token = this.openToken(account);
    await this.step(account, () =>
      this.provider.configureSoftware(token, input.softwareId, input.pin),
    );
    account.softwareId = input.softwareId;
    if (input.testSetId) account.testSetId = input.testSetId;
    if (account.step === 'software') account.step = 'set_pruebas';
    account.updatedByEmail = user.email;
    await account.save();
    return this.list(user);
  }

  /**
   * Registra en el facturador la resolución de la sede y la numeración de
   * notas crédito del NIT. Se llama al conectar y cada vez que la sede renueva
   * su resolución.
   */
  async syncResolutions(sedeId: string, user: JwtUser): Promise<AccountView[]> {
    this.assertProviderEnabled();
    assertSedeAccess(user, sedeId);
    const sede = await this.sedes.findOrFail(sedeId);
    const nit = normalizeNit(sede.nit);
    const account = await this.accountOrFail(nit);
    const r = sede.resolucionFe;
    if (!r?.numero || !r.rangoHasta || !r.claveTecnica) {
      throw new BadRequestException(
        'La resolución de la sede está incompleta: hacen falta número, rango y clave técnica.',
      );
    }
    const token = this.openToken(account);
    const ymd = (d?: Date) => (d ? new Date(d).toISOString().slice(0, 10) : undefined);
    await this.step(account, async () => {
      await this.provider.configureResolution(token, {
        kind: 'invoice',
        prefix: r.prefijo ?? '',
        from: r.rangoDesde ?? 1,
        to: r.rangoHasta!,
        resolutionNumber: r.numero,
        resolutionDate: ymd(r.fechaResolucion),
        technicalKey: r.claveTecnica,
        dateFrom: ymd(r.vigenciaDesde),
        dateTo: ymd(r.vigenciaHasta),
      });
      await this.provider.configureResolution(token, {
        kind: 'credit_note',
        prefix: CREDIT_NOTE_PREFIX,
        from: CREDIT_NOTE_RANGE.from,
        to: CREDIT_NOTE_RANGE.to,
      });
    });
    await account.save();
    return this.list(user);
  }

  /** Rangos que la DIAN tiene para el software (trae la clave técnica). */
  async numberingRanges(nit: string, user: JwtUser): Promise<NumberingRange[]> {
    this.assertProviderEnabled();
    await this.sedesOfNit(nit, user);
    const account = await this.accountOrFail(nit);
    if (!account.softwareId) {
      throw new BadRequestException('Primero registra el software propio.');
    }
    const token = this.openToken(account);
    return this.step(account, () =>
      this.provider.getNumberingRanges(token, account.softwareId!),
    );
  }

  private testSetView(a: EinvoicingAccountDocument | null | undefined): TestSetView {
    const docs: TestSetDoc[] = (a?.testSetDocs ?? []).map((d) => ({
      kind: d.kind,
      prefix: d.prefix,
      number: d.number,
      cufe: d.cufe,
      zipKey: d.zipKey,
      status: d.status,
      message: d.message,
      errors: d.dianErrors ?? [],
    }));
    return { sentAt: a?.testSetSentAt, docs, summary: summarizeTestSet(docs) };
  }

  /** Lo que respondió la DIAN, en el estado de un documento del set. */
  private toTestDoc(base: Omit<TestSetDoc, 'status' | 'errors'>, out: SendOutcome): TestSetDoc {
    const status: TestSetDoc['status'] =
      out.status === 'accepted'
        ? 'accepted'
        : out.status === 'rejected' || out.status === 'failed'
          ? 'rejected'
          : 'pending';
    return {
      ...base,
      cufe: out.cufe ?? base.cufe,
      zipKey: out.zipKey ?? base.zipKey,
      status,
      message: out.message,
      errors: out.errors,
    };
  }

  /**
   * Paso 4: manda el set de pruebas de la DIAN (8 facturas, 1 nota crédito y
   * 1 nota débito) con la numeración de pruebas. El resultado llega después:
   * se consulta con `checkTestSet`.
   *
   * Cada envío usa números nuevos, así que se puede repetir si algo falló.
   */
  async runTestSet(nit: string, user: JwtUser): Promise<TestSetView> {
    this.assertProviderEnabled();
    const sedes = await this.sedesOfNit(nit, user);
    const account = await this.accountOrFail(nit);
    if (account.step !== 'set_pruebas' || !account.testSetId) {
      throw new BadRequestException(
        'Antes del set de pruebas hay que cargar el certificado y registrar el software con su ID de set de pruebas.',
      );
    }
    const token = this.openToken(account);
    const testSetId = account.testSetId;
    const sede = sedes[0]!;
    const issuer = {
      nit,
      dv: account.dv ?? sede.nitDv,
      name: sede.businessName || sede.name,
      address: sede.address,
      phone: sede.phone,
      email: sede.emailFacturacion,
      departamento: sede.departamento,
      ciudad: sede.ciudad,
    };
    const r = DIAN_HABILITACION_RESOLUTION;

    // Numeración de pruebas en el facturador: factura, nota crédito y débito.
    await this.step(account, async () => {
      await this.provider.configureResolution(token, {
        kind: 'invoice',
        prefix: r.prefix,
        from: r.from,
        to: r.to,
        resolutionNumber: r.resolutionNumber,
        resolutionDate: r.resolutionDate,
        technicalKey: r.technicalKey,
        dateFrom: r.dateFrom,
        dateTo: r.dateTo,
      });
      await this.provider.configureResolution(token, {
        kind: 'credit_note',
        prefix: TEST_NOTE_PREFIX.credit_note,
        from: CREDIT_NOTE_RANGE.from,
        to: CREDIT_NOTE_RANGE.to,
      });
      await this.provider.configureResolution(token, {
        kind: 'debit_note',
        prefix: TEST_NOTE_PREFIX.debit_note,
        from: CREDIT_NOTE_RANGE.from,
        to: CREDIT_NOTE_RANGE.to,
      });
    });

    const { issueDate, issueTime } = colombiaNow();
    const first = r.from + 1 + (account.testSetInvoiceSeq ?? 0);
    const invoices = buildTestInvoices(issuer, first, issueDate, issueTime);
    const docs: TestSetDoc[] = [];
    const send = async (doc: EinvoiceDocument): Promise<TestSetDoc> => {
      const base = { kind: doc.kind, prefix: doc.prefix, number: doc.number };
      try {
        const out =
          doc.kind === 'invoice'
            ? await this.provider.sendInvoice(token, doc, { testSetId })
            : doc.kind === 'credit_note'
              ? await this.provider.sendCreditNote(token, doc, { testSetId })
              : await this.provider.sendDebitNote(token, doc, { testSetId });
        return this.toTestDoc(base, out);
      } catch (err) {
        return {
          ...base,
          status: 'rejected',
          message: err instanceof Error ? err.message : String(err),
          errors: [],
        };
      }
    };

    // En orden: las notas necesitan el CUFE de facturas ya enviadas.
    for (const inv of invoices) docs.push(await send(inv));
    const notes: [('credit_note' | 'debit_note'), number][] = [
      ['credit_note', 0],
      ['debit_note', 1],
    ];
    let noteSeq = account.testSetNoteSeq ?? 0;
    for (const [kind, idx] of notes) {
      const inv = invoices[idx]!;
      const cufe = docs[idx]?.cufe;
      noteSeq += 1;
      if (!cufe) {
        docs.push({
          kind,
          prefix: TEST_NOTE_PREFIX[kind],
          number: noteSeq,
          status: 'rejected',
          message: 'No se envió: la factura que corrige no obtuvo CUFE.',
          errors: [],
        });
        continue;
      }
      docs.push(await send(buildTestNote(kind, inv, cufe, noteSeq, issueDate, issueTime)));
    }

    account.testSetDocs = docs.map(toEntry);
    account.testSetSentAt = new Date();
    account.testSetInvoiceSeq = (account.testSetInvoiceSeq ?? 0) + invoices.length;
    account.testSetNoteSeq = noteSeq;
    account.updatedByEmail = user.email;
    await account.save();
    this.logger.log(`Set de pruebas del NIT ${nit} enviado por ${user.email}.`);
    return this.testSetView(account);
  }

  /** Consulta a la DIAN el resultado de los documentos del set aún pendientes. */
  async checkTestSet(nit: string, user: JwtUser): Promise<TestSetView> {
    this.assertProviderEnabled();
    await this.sedesOfNit(nit, user);
    const account = await this.accountOrFail(nit);
    const token = this.openToken(account);
    const docs: TestSetDoc[] = [];
    for (const d of account.testSetDocs ?? []) {
      const current: TestSetDoc = {
        kind: d.kind,
        prefix: d.prefix,
        number: d.number,
        cufe: d.cufe,
        zipKey: d.zipKey,
        status: d.status,
        message: d.message,
        errors: d.dianErrors ?? [],
      };
      if (current.status !== 'pending' || !current.zipKey) {
        docs.push(current);
        continue;
      }
      try {
        const out = await this.provider.getZipStatus(token, current.zipKey);
        docs.push(this.toTestDoc(current, out));
      } catch (err) {
        docs.push({ ...current, message: err instanceof Error ? err.message : String(err) });
      }
    }
    account.testSetDocs = docs.map(toEntry);
    await account.save();
    return this.testSetView(account);
  }

  /** Cambia el ambiente. Pasar a producción es el último paso. */
  async setEnvironment(
    nit: string,
    environment: EinvoiceEnvironmentName,
    user: JwtUser,
  ): Promise<AccountView[]> {
    this.assertProviderEnabled();
    await this.sedesOfNit(nit, user);
    const account = await this.accountOrFail(nit);
    if (environment === 'produccion' && account.step !== 'produccion') {
      const set = summarizeTestSet(this.testSetView(account).docs);
      if (account.step !== 'set_pruebas' || !set.complete) {
        throw new BadRequestException(
          'Antes de producción hay que pasar el set de pruebas: la DIAN debe aceptar las 8 facturas, la nota crédito y la nota débito.',
        );
      }
    }
    const token = this.openToken(account);
    await this.step(account, () => this.provider.setEnvironment(token, environment));
    account.environment = environment;
    if (environment === 'produccion') account.step = 'produccion';
    account.updatedByEmail = user.email;
    await account.save();
    this.logger.log(`NIT ${nit} pasa a ${environment} (${user.email}).`);
    return this.list(user);
  }
}
