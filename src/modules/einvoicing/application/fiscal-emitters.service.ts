import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  FiscalEmitter,
  FiscalEmitterDocument,
} from '../infrastructure/schemas/fiscal-emitter.schema';
import { Sede, SedeDocument } from '../../sedes/infrastructure/schemas/sede.schema';
import {
  cifrar,
  contextoSecreto,
  descifrar,
  type SecretoCifrado,
} from '../../../shared/crypto/secretos';
import { normalizarNit } from '../domain/consecutivo-unico';
import {
  CAMPOS_SECRETOS_EMISOR,
  certificadoVigente,
  datosEmisorDeSede,
  estadoDeEmisor,
  type CampoSecretoEmisor,
  type EstadoConfiguracion,
} from '../domain/emisor-fiscal';
import { resolverTransmisor } from '../domain/resolver-transmisor';
import { StubDian } from '../domain/stub-dian';
import type { TransmisorDian } from '../domain/transmisor-dian';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { assertSedeAccess } from '../../core-auth/domain/sede-access';
import { avisoCertificado, type AvisoCertificado } from '../domain/certificado-p12';
import { EinvoicingStorageService } from '../../../shared/storage/einvoicing-storage.service';
import { AuditService } from '../../core-audit/application/audit.service';

/**
 * Credenciales DIAN que se guardan en el emisor. Los secretos llegan en claro
 * y se cifran aquí; un campo ausente no se toca.
 */
export interface CredencialesEmisorInput {
  facturaSoftwareId?: string;
  facturaPin?: string;
  facturaTestSetId?: string;
  nominaSoftwareId?: string;
  nominaPin?: string;
  nominaTestSetId?: string;
}

/**
 * Lo que la pantalla puede ver del emisor. Lista cerrada a propósito: nada de
 * `toObject()` ni spread del documento, para que un campo nuevo (o un secreto)
 * no se cuele solo en la respuesta.
 */
export interface EmisorVista {
  id: string;
  razonSocial?: string;
  nit: string;
  nitDv?: string;
  tipoPersona?: string;
  responsabilidadFiscal?: string;
  responsableIva?: boolean;
  responsableInc?: boolean;
  franquicia?: boolean;
  granContribuyente?: boolean;
  regimenRenta?: string;
  ciiu?: string;
  direccion?: string;
  departamento?: string;
  ciudad?: string;
  municipioDane?: string;
  telefono?: string;
  emailFacturacion?: string;
  tipoAmbiente: string;
  habilitado: boolean;
  facturaSoftwareId?: string;
  nominaSoftwareId?: string;
  certVenceAt?: Date;
  certTitular?: string;
  /** SHA-256 del certificado (hex). Identifica la carga; no es secreto. */
  certHuella?: string;
  /** Hay archivo, contraseña y no ha vencido. */
  certificadoVigente: boolean;
  /** 'por-vencer' (≤ 30 días), 'vencido' o null. Se calcula al leer. */
  certAviso: AvisoCertificado | null;
  tieneFacturaPin: boolean;
  tieneFacturaTestSetId: boolean;
  tieneNominaPin: boolean;
  tieneNominaTestSetId: boolean;
  tieneCertificado: boolean;
}

const SELECT_SECRETOS = '+facturaPin +nominaPin +certPasswordCifrada';

function isDuplicateKeyError(err: unknown): boolean {
  return (err as { code?: number })?.code === 11000;
}

const idValido = (id: string) => Types.ObjectId.isValid(id);

/**
 * El .p12 y su contraseña, listos para firmar. Solo vive en el servidor:
 * `toJSON` y `util.inspect` lo tapan, así que un `logger.log(cert)` o un
 * `JSON.stringify` accidental no saca ni la llave ni la contraseña.
 */
export class CertificadoCargado {
  // Campos privados de verdad: `{ ...cert }`, `Object.entries` y
  // `Object.keys` no los ven.
  readonly #p12: Buffer;
  readonly #password: string;

  constructor(p12: Buffer, password: string) {
    this.#p12 = p12;
    this.#password = password;
  }

  get p12(): Buffer {
    return this.#p12;
  }

  get password(): string {
    return this.#password;
  }

  toJSON(): string {
    return '[certificado .p12 oculto]';
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[certificado .p12 oculto]';
  }
}

/**
 * Emisores fiscales (uno por NIT) de la empresa activa. La emisión actual
 * todavía lee los datos fiscales de la sede (`EinvoicingService.buildEmisor`):
 * este servicio prepara el camino de las Fases 3-4 sin cambiar lo que sale hoy.
 */
@Injectable()
export class FiscalEmittersService {
  private readonly logger = new Logger(FiscalEmittersService.name);

  constructor(
    @InjectModel(FiscalEmitter.name)
    private readonly model: Model<FiscalEmitterDocument>,
    @InjectModel(Sede.name)
    private readonly sedes: Model<SedeDocument>,
    private readonly storage: EinvoicingStorageService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Emisor de la sede, o `null` si aún no tiene. Sin secretos. Si el emisor
   * enlazado es de otro NIT (la sede cambió de NIT y nadie la reenlazó), el
   * enlace está viejo y también devuelve `null`: transmitir con las
   * credenciales de otro NIT sería firmar a nombre de otro facturador.
   */
  async obtenerPorSede(sedeId: string): Promise<FiscalEmitterDocument | null> {
    const sede = await this.sedeOrFail(sedeId);
    if (!sede.emisorId) return null;
    const emisor = await this.model.findById(sede.emisorId).exec();
    if (!emisor) return null;
    if (emisor.nitNorm !== normalizarNit(sede.nit)) {
      // Sin el NIT en claro: basta con los ids para encontrarlo.
      this.logger.warn(
        `Sede ${String(sede._id)}: su emisor ${emisor.id as string} es de otro NIT; ` +
          'se trata como sin emisor hasta reenlazarla (asegurarParaSede).',
      );
      return null;
    }
    return emisor;
  }

  /**
   * Devuelve el emisor del NIT de la sede, creándolo con los datos de la sede si
   * no existe, y deja la sede apuntando a él. Dos sedes con el mismo NIT
   * comparten emisor: si ya existe, no se sobrescriben sus datos con los de
   * esta sede. Si el NIT de la sede cambió, se reenlaza al emisor del NIT nuevo.
   */
  async asegurarParaSede(sedeId: string): Promise<FiscalEmitterDocument> {
    const sede = await this.sedeOrFail(sedeId);
    const datos = datosEmisorDeSede(sede);
    if (!datos) {
      throw new BadRequestException(
        'La sede no tiene NIT: no se le puede asignar un emisor fiscal.',
      );
    }
    if (sede.emisorId) {
      const actual = await this.model.findById(sede.emisorId).exec();
      if (actual && actual.nitNorm === datos.nitNorm) return actual;
    }
    let emisor = await this.model.findOne({ nitNorm: datos.nitNorm }).exec();
    if (!emisor) {
      try {
        emisor = await this.model.create(datos);
      } catch (err) {
        // Otra sede del mismo NIT lo creó a la vez: el índice único lo impide
        // y nos quedamos con el suyo.
        if (!isDuplicateKeyError(err)) throw err;
        emisor = await this.model.findOne({ nitNorm: datos.nitNorm }).exec();
        if (!emisor) throw err;
      }
    }
    await this.sedes
      .updateOne({ _id: sede._id }, { $set: { emisorId: emisor._id } })
      .exec();
    return emisor;
  }

  /**
   * Qué le falta al emisor para emitir. Lee la presencia de los secretos sin
   * descifrarlos y sin devolverlos.
   */
  async estadoConfiguracion(
    emisorId: string,
    ahora: Date = new Date(),
  ): Promise<EstadoConfiguracion> {
    const e = await this.conSecretosOrFail(emisorId);
    return estadoDeEmisor(
      {
        razonSocial: e.razonSocial,
        nitDv: e.nitDv,
        tipoPersona: e.tipoPersona,
        municipioDane: e.municipioDane,
        direccion: e.direccion,
        emailFacturacion: e.emailFacturacion,
        facturaSoftwareId: e.facturaSoftwareId,
        facturaTestSetId: e.facturaTestSetId,
        certPath: e.certPath,
        certVenceAt: e.certVenceAt,
        tipoAmbiente: e.tipoAmbiente,
        habilitado: e.habilitado,
        tieneFacturaPin: e.get('facturaPin') != null,
        tieneCertPassword: e.get('certPasswordCifrada') != null,
      },
      ahora,
    );
  }

  /**
   * Transmisor de la sede según su emisor real. Hasta que exista `DirectoDian`
   * (Fases 3-4) siempre es un stub; sin emisor, el stub lo dice.
   */
  async transmisorParaSede(sedeId: string): Promise<TransmisorDian> {
    const emisor = await this.obtenerPorSede(sedeId);
    if (!emisor) {
      return new StubDian('Falta configurar: la sede no tiene emisor fiscal');
    }
    return resolverTransmisor(await this.estadoConfiguracion(emisor.id));
  }

  /**
   * Guarda credenciales DIAN. Los secretos se cifran con el contexto
   * `<emisorId>:<campo>`; sin `EINVOICING_ENCRYPTION_KEY` lanza y no guarda
   * nada. El certificado .p12 NO pasa por aquí: su único camino es
   * `CertificadoEmisorService.cargar`, que lo valida antes de guardarlo.
   */
  async guardarCredenciales(
    emisorId: string,
    input: CredencialesEmisorInput,
  ): Promise<void> {
    const emisor = await this.model.findById(this.oid(emisorId)).exec();
    if (!emisor) throw new NotFoundException('Emisor fiscal no encontrado');
    const id = emisor.id as string;
    const secreto = (texto: string, campo: CampoSecretoEmisor): SecretoCifrado =>
      cifrar(texto, contextoSecreto(id, campo));

    // Se cifra todo antes de escribir: si falta la llave no queda nada a medias.
    const set: Record<string, unknown> = {};
    if (input.facturaSoftwareId !== undefined) set.facturaSoftwareId = input.facturaSoftwareId;
    if (input.facturaTestSetId !== undefined) set.facturaTestSetId = input.facturaTestSetId;
    if (input.nominaSoftwareId !== undefined) set.nominaSoftwareId = input.nominaSoftwareId;
    if (input.nominaTestSetId !== undefined) set.nominaTestSetId = input.nominaTestSetId;
    if (input.facturaPin) set.facturaPin = secreto(input.facturaPin, 'facturaPin');
    if (input.nominaPin) set.nominaPin = secreto(input.nominaPin, 'nominaPin');
    if (Object.keys(set).length === 0) return;
    await this.model.updateOne({ _id: emisor._id }, { $set: set }).exec();
  }

  /**
   * Descifra un secreto del emisor para usarlo en el servidor (firmar, CUDE).
   * `null` si no está guardado o falta la llave. Nunca lo loguees ni lo
   * devuelvas en una respuesta.
   */
  async leerSecreto(emisorId: string, campo: CampoSecretoEmisor): Promise<string | null> {
    // El tipo no protege en runtime: un campo cualquiera leería un dato del
    // documento como si fuera secreto.
    if (!(CAMPOS_SECRETOS_EMISOR as readonly string[]).includes(campo)) {
      throw new Error(`Campo secreto desconocido: ${String(campo)}`);
    }
    const e = await this.conSecretosOrFail(emisorId);
    const valor = e.get(campo) as SecretoCifrado | undefined;
    return descifrar(valor ?? null, contextoSecreto(e.id as string, campo));
  }

  /**
   * Lee el .p12 del emisor y descifra su contraseña para firmar (Fase 3). Solo
   * para el servidor: nunca lo devuelvas en una respuesta ni lo loguees.
   * `null` si el emisor no tiene certificado o falta la llave de cifrado.
   * Cada lectura queda en la auditoría con la huella, nunca con la contraseña.
   */
  async cargarCertificado(
    emisorId: string,
    motivo = 'firma',
  ): Promise<CertificadoCargado | null> {
    const e = await this.conSecretosOrFail(emisorId);
    if (!e.certPath) return null;
    const id = e.id as string;
    const password = descifrar(
      (e.get('certPasswordCifrada') as SecretoCifrado | undefined) ?? null,
      contextoSecreto(id, 'certPasswordCifrada'),
    );
    if (password == null) return null;
    // La ruta se rearma desde el nombre con la empresa del contexto: un
    // `certPath` alterado no puede apuntar a la carpeta de otra empresa.
    const nombre = e.certPath.split('/').pop() ?? '';
    const p12 = await this.storage.leerCertificado(id, nombre);
    await this.audit.record({
      method: 'SERVER',
      path: `/einvoicing/emisores/${id}/certificado`,
      success: true,
      action: 'einvoicing.certificado.usado',
      detail: { emisorId: id, huella: e.certHuella ?? '', motivo: String(motivo).slice(0, 60) },
    });
    return new CertificadoCargado(p12, password);
  }

  /** Emisor de la sede para la pantalla, con su estado. Sin secretos. */
  async vistaDeSede(
    sedeId: string,
    user: JwtUser,
  ): Promise<{ emisor: EmisorVista | null; estado: EstadoConfiguracion | null }> {
    assertSedeAccess(user, sedeId);
    const emisor = await this.obtenerPorSede(sedeId);
    if (!emisor) return { emisor: null, estado: null };
    const conSecretos = await this.conSecretosOrFail(emisor.id as string);
    return {
      emisor: this.vista(conSecretos),
      estado: await this.estadoConfiguracion(emisor.id as string),
    };
  }

  /** Proyección cerrada del emisor: solo campos públicos y booleanos. */
  vista(e: FiscalEmitterDocument, ahora: Date = new Date()): EmisorVista {
    const tieneCertPassword = e.get('certPasswordCifrada') != null;
    return {
      id: e.id as string,
      razonSocial: e.razonSocial,
      nit: e.nit,
      nitDv: e.nitDv,
      tipoPersona: e.tipoPersona,
      responsabilidadFiscal: e.responsabilidadFiscal,
      responsableIva: e.responsableIva,
      responsableInc: e.responsableInc,
      franquicia: e.franquicia,
      granContribuyente: e.granContribuyente,
      regimenRenta: e.regimenRenta,
      ciiu: e.ciiu,
      direccion: e.direccion,
      departamento: e.departamento,
      ciudad: e.ciudad,
      municipioDane: e.municipioDane,
      telefono: e.telefono,
      emailFacturacion: e.emailFacturacion,
      tipoAmbiente: e.tipoAmbiente,
      habilitado: e.habilitado === true,
      facturaSoftwareId: e.facturaSoftwareId,
      nominaSoftwareId: e.nominaSoftwareId,
      certVenceAt: e.certVenceAt,
      certTitular: e.certTitular,
      certHuella: e.certHuella,
      certificadoVigente: certificadoVigente(
        { certPath: e.certPath, certVenceAt: e.certVenceAt, tieneCertPassword, tieneFacturaPin: false },
        ahora,
      ),
      certAviso: e.certPath ? avisoCertificado(e.certVenceAt, ahora) : null,
      tieneFacturaPin: e.get('facturaPin') != null,
      tieneFacturaTestSetId: !!e.facturaTestSetId,
      tieneNominaPin: e.get('nominaPin') != null,
      tieneNominaTestSetId: !!e.nominaTestSetId,
      tieneCertificado: !!e.certPath && tieneCertPassword,
    };
  }

  private oid(id: string): Types.ObjectId {
    if (!idValido(id)) throw new NotFoundException('Emisor fiscal no encontrado');
    return new Types.ObjectId(id);
  }

  private async conSecretosOrFail(emisorId: string): Promise<FiscalEmitterDocument> {
    const e = await this.model.findById(this.oid(emisorId)).select(SELECT_SECRETOS).exec();
    if (!e) throw new NotFoundException('Emisor fiscal no encontrado');
    return e;
  }

  private async sedeOrFail(sedeId: string): Promise<SedeDocument> {
    const sede = idValido(sedeId) ? await this.sedes.findById(sedeId).exec() : null;
    if (!sede) throw new NotFoundException('Sede no encontrada');
    return sede;
  }
}
