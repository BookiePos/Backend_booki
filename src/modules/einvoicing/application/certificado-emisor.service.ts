import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  FiscalEmitter,
  FiscalEmitterDocument,
} from '../infrastructure/schemas/fiscal-emitter.schema';
import { FiscalEmittersService, type EmisorVista } from './fiscal-emitters.service';
import { EinvoicingStorageService } from '../../../shared/storage/einvoicing-storage.service';
import { AuditService } from '../../core-audit/application/audit.service';
import { BusinessService } from '../../control/application/business.service';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import { assertSedeAccess } from '../../core-auth/domain/sede-access';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import {
  cifrar,
  contextoSecreto,
  leerLlave,
  VARIABLE_LLAVE,
} from '../../../shared/crypto/secretos';
import {
  avisoCertificado,
  CertificadoInvalidoError,
  nitDelEmisor,
  validarCertificadoP12,
} from '../domain/certificado-p12';
import { recorrerEmpresas } from '../../../shared/barridos/recorrer-empresas';
import type { ResultadoBarrido } from '../../../shared/barridos/resultado-barrido';

/**
 * Tope del .p12. Uno real (certificado, cadena de la ECD y llave cifrada) pesa
 * 3-10 KB; 50 KB deja margen para cadenas largas sin aceptar basura grande.
 */
export const CERT_MAX_BYTES = 50 * 1024;
const RE_EXTENSION = /\.(p12|pfx)$/i;
const PASSWORD_MAX = 256;

/** Archivo subido. Se declara aquí para no añadir `@types/multer`. */
export interface ArchivoCertificado {
  buffer: Buffer;
  size: number;
  originalname?: string;
  mimetype?: string;
}

/** Tiempo para recorrer empresas si nadie fija un plazo. */
const PRESUPUESTO_MS = 60_000;

/**
 * Lanza 503 si la llave de cifrado no está o está mal formada. Va ANTES de
 * leer el archivo: sin llave no se puede guardar la contraseña, y un .p12 sin
 * su contraseña en el bucket no sirve para nada.
 */
export function assertLlaveDeCifrado(env: NodeJS.ProcessEnv = process.env): void {
  let llave: Buffer | null;
  try {
    llave = leerLlave(env);
  } catch {
    throw new ServiceUnavailableException(
      `La llave de cifrado de la factura electrónica (${VARIABLE_LLAVE}) está mal configurada: no se puede guardar el certificado. Avisa a soporte.`,
    );
  }
  if (!llave) {
    throw new ServiceUnavailableException(
      `Falta la llave de cifrado de la factura electrónica (${VARIABLE_LLAVE}): no se puede guardar el certificado. Avisa a soporte.`,
    );
  }
}

function sello(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
}

/**
 * Carga y reemplazo del certificado .p12 de un emisor, y el aviso de
 * vencimiento (Fase 3). La lectura para firmar está en
 * `FiscalEmittersService.cargarCertificado`.
 *
 * Reemplazo: el anterior sigue siendo el vigente hasta que el nuevo pasa la
 * validación, se sube con un nombre propio y la base apunta a él. Solo
 * entonces se BORRA el anterior del bucket. No se conserva como
 * `anterior-<fecha>.p12` porque su contraseña cifrada se sobrescribe en el
 * mismo paso (sin ella el archivo no sirve) y guardar llaves privadas viejas
 * solo agranda lo que se puede filtrar. Lo firmado con él lleva el certificado
 * público dentro del XML (KeyInfo), así que se puede verificar sin el .p12; y la
 * huella del anterior queda en la auditoría.
 */
@Injectable()
export class CertificadoEmisorService {
  private readonly logger = new Logger(CertificadoEmisorService.name);
  private barriendo = false;

  constructor(
    @InjectModel(FiscalEmitter.name)
    private readonly model: Model<FiscalEmitterDocument>,
    private readonly emisores: FiscalEmittersService,
    private readonly storage: EinvoicingStorageService,
    private readonly audit: AuditService,
    private readonly businesses: BusinessService,
  ) {}

  /**
   * Sube el .p12 del emisor de la sede. Valida antes de tocar nada: si el
   * nuevo no sirve, el anterior sigue intacto.
   */
  async cargar(
    sedeId: string,
    archivo: ArchivoCertificado | undefined,
    password: string,
    user: JwtUser,
    ip?: string,
    ahora: Date = new Date(),
  ): Promise<{ emisor: EmisorVista | null; reemplazado: boolean }> {
    assertSedeAccess(user, sedeId);
    assertLlaveDeCifrado();
    this.storage.assertDisponible();

    if (!archivo?.buffer?.length) {
      throw new BadRequestException('Adjunta el certificado .p12 en el campo "file".');
    }
    if (archivo.size > CERT_MAX_BYTES || archivo.buffer.length > CERT_MAX_BYTES) {
      throw new BadRequestException('El certificado pesa más de 50 KB: no parece un .p12.');
    }
    if (archivo.originalname && !RE_EXTENSION.test(archivo.originalname)) {
      throw new BadRequestException('El certificado debe ser un archivo .p12 o .pfx.');
    }
    if (typeof password !== 'string' || !password || password.length > PASSWORD_MAX) {
      throw new BadRequestException('Escribe la contraseña del certificado.');
    }

    const emisor = await this.emisores.asegurarParaSede(sedeId);
    const emisorId = emisor.id as string;

    let validado;
    try {
      validado = validarCertificadoP12(archivo.buffer, password, nitDelEmisor(emisor), ahora);
    } catch (err) {
      if (err instanceof CertificadoInvalidoError) {
        // Sin detalle del contenido: solo el motivo y el emisor.
        this.logger.warn(`Certificado rechazado para el emisor ${emisorId}: ${err.motivo}`);
        throw new BadRequestException(err.message);
      }
      throw err;
    }

    // Se cifra antes de subir: si falla, no queda un archivo huérfano.
    const passwordCifrada = cifrar(password, contextoSecreto(emisorId, 'certPasswordCifrada'));
    const anterior = emisor.certPath;
    const huellaAnterior = emisor.certHuella;
    // El sufijo aleatorio hace única cada carga: un doble clic con el mismo
    // .p12 en el mismo segundo no comparte ruta con la carga que ganó.
    const nombre = `cert-${sello(ahora)}-${validado.huellaSha256.slice(0, 12)}-${randomUUID().slice(0, 8)}.p12`;
    const { pathname } = await this.storage.guardarCertificado(emisorId, nombre, archivo.buffer);

    const aviso = avisoCertificado(validado.venceAt, ahora);
    let res: { matchedCount?: number };
    try {
      // Condicionado al certificado que había al leer: si otra carga ganó la
      // carrera, esta no la pisa (y su archivo se borra abajo).
      res = await this.model
        .updateOne(
          { _id: emisor._id, certPath: anterior ?? null },
          {
            $set: {
              certPath: pathname,
              certVenceAt: validado.venceAt,
              certTitular: validado.titular,
              certHuella: validado.huellaSha256,
              certPasswordCifrada: passwordCifrada,
              ...(aviso ? { certAviso: aviso, certAvisoAt: ahora } : {}),
            },
            ...(aviso ? {} : { $unset: { certAviso: 1, certAvisoAt: 1 } }),
          },
        )
        .exec();
    } catch (err) {
      await this.borrarSiNoEsElVigente(emisor._id, emisorId, pathname, nombre);
      throw err;
    }
    if (!res.matchedCount) {
      await this.borrarSiNoEsElVigente(emisor._id, emisorId, pathname, nombre);
      throw new ConflictException(
        'Otro certificado se cargó al mismo tiempo para este emisor. Recarga y vuelve a intentarlo.',
      );
    }

    const reemplazado = !!anterior && anterior !== pathname;
    if (reemplazado) {
      await this.borrarSinFallar(emisorId, anterior.split('/').pop() ?? '');
    }

    await this.audit.record({
      userId: user.userId,
      userEmail: user.email,
      userName: user.name,
      role: user.role,
      method: 'POST',
      path: `/einvoicing/sedes/${sedeId}/emisor/certificado`,
      statusCode: 201,
      success: true,
      ip,
      action: reemplazado ? 'einvoicing.certificado.reemplazado' : 'einvoicing.certificado.cargado',
      detail: {
        emisorId,
        huella: validado.huellaSha256,
        ...(reemplazado ? { huellaAnterior: huellaAnterior ?? '' } : {}),
        venceAt: validado.venceAt.toISOString(),
        ecd: validado.emisorCertificado,
      },
    });

    const { emisor: vista } = await this.emisores.vistaDeSede(sedeId, user);
    return { emisor: vista, reemplazado };
  }

  /**
   * Marca `certAviso` en los emisores de una empresa (contexto ya abierto):
   * 'por-vencer' a 30 días o menos, 'vencido' si pasó; lo quita si ya no
   * aplica. Devuelve cuántos quedaron en cada estado.
   */
  async marcarAvisos(ahora: Date = new Date()): Promise<{ porVencer: number; vencidos: number }> {
    const emisores = await this.model
      .find({ certPath: { $exists: true, $ne: null } })
      .select('_id certVenceAt certAviso')
      .exec();
    let porVencer = 0;
    let vencidos = 0;
    for (const e of emisores) {
      const aviso = avisoCertificado(e.certVenceAt, ahora);
      if (aviso === 'por-vencer') porVencer++;
      if (aviso === 'vencido') vencidos++;
      if ((e.certAviso ?? null) === aviso) continue;
      await this.model
        .updateOne(
          { _id: e._id },
          aviso
            ? { $set: { certAviso: aviso, certAvisoAt: ahora } }
            : { $unset: { certAviso: 1, certAvisoAt: 1 } },
        )
        .exec();
    }
    return { porVencer, vencidos };
  }

  /**
   * Barrido de `/cron/diario`: recorre las empresas activas y marca los
   * certificados por vencer. Nunca lanza; los fallos van en el resultado.
   */
  async barrerVencimientos(opts: { hasta?: number; ahora?: Date } = {}): Promise<ResultadoBarrido> {
    if (this.barriendo) {
      return { estado: 'omitido', detalle: 'ya hay un barrido de certificados en marcha' };
    }
    this.barriendo = true;
    try {
      const ahora = opts.ahora ?? new Date();
      const businesses = await this.businesses.listActive();
      let porVencer = 0;
      let vencidos = 0;
      const { procesadas, pendientes, fallidas } = await recorrerEmpresas(
        businesses,
        async (biz) => {
          const businessId = biz._id.toString();
          try {
            const r = await TenantContext.run(
              { businessId, dbName: biz.dbName, tipoNegocio: biz.tipoNegocio },
              () => this.marcarAvisos(ahora),
            );
            porVencer += r.porVencer;
            vencidos += r.vencidos;
          } catch (err) {
            this.logger.error(
              `Fallo revisando certificados de ${businessId}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            throw err;
          }
        },
        { hasta: opts.hasta ?? Date.now() + PRESUPUESTO_MS, clave: (biz) => biz._id.toString() },
      );
      const cifras = {
        empresas: businesses.length,
        procesadas,
        pendientes,
        porVencer,
        vencidos,
        fallidas: fallidas.length,
      };
      if (fallidas.length > 0 || pendientes > 0) {
        const partes = [
          fallidas.length > 0 ? `falló en ${fallidas.length} empresa(s)` : '',
          pendientes > 0 ? `${pendientes} empresa(s) sin procesar por tiempo` : '',
        ].filter(Boolean);
        return { estado: 'error', detalle: partes.join('; '), cifras };
      }
      return { estado: 'ok', cifras };
    } catch (err) {
      const detalle = err instanceof Error ? err.message : String(err);
      this.logger.error(`Fallo en el barrido de certificados: ${detalle}`);
      return { estado: 'error', detalle };
    } finally {
      this.barriendo = false;
    }
  }

  /**
   * Borra el archivo recién subido de una carga que no quedó, salvo que la base
   * ya apunte a él (p. ej. el `updateOne` sí escribió y lo que falló fue la
   * respuesta): nunca se borra el certificado vigente.
   */
  private async borrarSiNoEsElVigente(
    _id: unknown,
    emisorId: string,
    pathname: string,
    nombre: string,
  ): Promise<void> {
    let vigente: string | undefined;
    try {
      const actual = await this.model.findById(_id).select('certPath').exec();
      vigente = actual?.certPath;
    } catch {
      // Sin poder confirmar, se deja el archivo: un huérfano es mejor que
      // borrar el certificado con el que se firma.
      return;
    }
    if (vigente === pathname) return;
    await this.borrarSinFallar(emisorId, nombre);
  }

  private async borrarSinFallar(emisorId: string, nombre: string): Promise<void> {
    try {
      await this.storage.borrarCertificado(emisorId, nombre);
    } catch (err) {
      this.logger.warn(
        `No se pudo borrar un certificado del emisor ${emisorId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
