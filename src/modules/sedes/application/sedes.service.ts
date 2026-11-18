import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { validateUploadedFile } from '../../../shared/storage/file-signature';
import { CobroDigital, Sede, SedeDocument } from '../infrastructure/schemas/sede.schema';
import { CreateSedeDto } from './dto/create-sede.dto';
import { UpdateSedeDto } from './dto/update-sede.dto';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import { effectiveEntitlements } from '../../control/domain/plans';
import { PlanUpgradeRequiredException } from '../../control/domain/plan-upgrade.exception';
import { advertenciasNoResponsableInc } from '../../core-tax/domain/sale-tax';
import { resolucionDeTipo, type TipoResolucion } from '../../einvoicing/domain/resolucion-tipos';
import type { ResolucionFeDto } from './dto/resolucion-fe.dto';
import { normalizarNit } from '../../einvoicing/domain/consecutivo-unico';
import { EmisorDeSedeService } from './emisor-de-sede.service';
import {
  camposClaveAlGuardar,
  leerClaveTecnicaDe,
  SELECT_CLAVES_TECNICAS,
  type ResolucionConClave,
} from './clave-tecnica';

/**
 * Resolución de factura tal como se guarda desde la ficha de la sede: los datos
 * del DTO, campo por campo (nada que el cliente mande de más llega a la base),
 * y la clave técnica cifrada. Sin clave en el DTO se conserva la que había: la
 * respuesta ya no la devuelve, así que el formulario no puede reenviarla.
 */
function resolucionFeParaGuardar(
  sedeId: string,
  dto: ResolucionFeDto,
  previa: ResolucionConClave | null | undefined,
) {
  return {
    numero: dto.numero,
    fechaResolucion: dto.fechaResolucion,
    prefijo: dto.prefijo,
    rangoDesde: dto.rangoDesde,
    rangoHasta: dto.rangoHasta,
    vigenciaDesde: dto.vigenciaDesde,
    vigenciaHasta: dto.vigenciaHasta,
    ...camposClaveAlGuardar(sedeId, 'invoice', dto.claveTecnica, previa),
  };
}

/**
 * Lo del RUT que se copia de una sede a otra. No va la dirección, la ciudad ni
 * el teléfono (son del local) ni el correo de facturación: el domicilio fiscal
 * vive en el emisor y lo comparten todas las sedes del NIT.
 */
export const CAMPOS_RUT_COPIABLES = [
  'nit',
  'nitDv',
  'businessName',
  'tipoPersona',
  'responsabilidadFiscal',
  'responsableIva',
  'responsableInc',
  'franquicia',
  'granContribuyente',
  'regimenRenta',
  'ciiu',
] as const satisfies readonly (keyof Sede)[];

export interface ResultadoCopiaFiscal {
  sedeId: string;
  /** `null` si la sede no se encontró. */
  nombre: string | null;
  /** `true` si quedó enlazada al mismo emisor que la sede de origen. */
  ok: boolean;
  mensaje: string;
}

/** Error de índice único de Mongo (documento duplicado). */
const MONGO_DUPLICATE_KEY = 11000;

function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: number }).code === MONGO_DUPLICATE_KEY
  );
}

/** Tope de la imagen del QR ya decodificada (cabe en el cuerpo JSON de 100 KB). */
export const QR_MAX_BYTES = 70_000;

/**
 * Valida el QR por su CONTENIDO (bytes mágicos), no por el tipo que declara el
 * cliente, y devuelve el data URL con el tipo real. SVG y HTML se rechazan.
 */
function validarImagenQr(dataUrl: string): string {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > QR_MAX_BYTES) {
    throw new BadRequestException('La imagen del QR pesa más de 70 KB: usa una más liviana');
  }
  const tipo = validateUploadedFile(
    bytes,
    ['image/png', 'image/jpeg', 'image/webp'],
    'una imagen PNG, JPG o WEBP',
  );
  return `data:${tipo.mime};base64,${base64}`;
}

@Injectable()
export class SedesService {
  constructor(
    @InjectModel(Sede.name) private readonly sedeModel: Model<SedeDocument>,
    // Opcional solo para los tests que arman el servicio a mano; el módulo siempre lo provee.
    @Optional() private readonly emisorDeSede?: EmisorDeSedeService,
  ) {}

  /**
   * Lista sedes. Si `scope` es un arreglo, limita a esas sedes (aislamiento
   * por usuario); si es `null`/`undefined`, devuelve todas.
   */
  list(scope?: string[] | null): Promise<SedeDocument[]> {
    const filter = scope ? { _id: { $in: scope } } : {};
    // La imagen del QR pesa ~95 KB por sede y casi todas las pantallas piden el
    // listado: se pide aparte con `cobroDigital()` al cobrar.
    return this.sedeModel
      .find(filter)
      .select('-cobroDigital.qrImagen')
      .sort({ code: 1 })
      .exec();
  }

  /** QR / llave Bre-B de la sede, con la imagen (solo al cobrar por QR). */
  async cobroDigital(id: string): Promise<CobroDigital | null> {
    const sede = await this.findOrFail(id);
    return sede.cobroDigital ?? null;
  }

  async create(dto: CreateSedeDto): Promise<SedeDocument> {
    const ctx = TenantContext.current();
    if (ctx?.plan) {
      const { quotas } = effectiveEntitlements(ctx.plan, ctx.addOns);
      const current = await this.count();
      if (current >= quotas.sedes) {
        throw new PlanUpgradeRequiredException(
          `Tu plan permite ${quotas.sedes} sede(s). Mejora el plan o agrega una sede adicional para crear más.`,
          { reason: 'quota', quota: 'sedes' },
        );
      }
    }
    try {
      // El id se fija antes de crear: la clave técnica se cifra atada a él.
      const _id = new Types.ObjectId();
      return await this.sedeModel.create({
        ...dto,
        _id,
        ...(dto.resolucionFe
          ? { resolucionFe: resolucionFeParaGuardar(_id.toString(), dto.resolucionFe, null) }
          : {}),
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        throw new ConflictException(`Ya existe una sede con el código ${dto.code}`);
      }
      throw err;
    }
  }

  async update(id: string, dto: UpdateSedeDto): Promise<SedeDocument> {
    // Con resolución en el DTO se reescribe el subdocumento entero: hay que
    // traer la clave guardada para conservarla.
    const sede =
      dto.resolucionFe !== undefined
        ? await this.findOrFailConClaves(id)
        : await this.findOrFail(id);
    const nitNormAntes = normalizarNit(sede.nit);

    if (dto.code !== undefined) sede.code = dto.code;
    if (dto.name !== undefined) sede.name = dto.name;
    if (dto.businessName !== undefined)
      sede.businessName = dto.businessName || undefined;
    if (dto.address !== undefined) sede.address = dto.address || undefined;
    if (dto.nit !== undefined) sede.nit = dto.nit || undefined;
    if (dto.phone !== undefined) sede.phone = dto.phone || undefined;
    if (dto.legalNote !== undefined)
      sede.legalNote = dto.legalNote || undefined;

    // Perfil fiscal (factura electrónica)
    if (dto.nitDv !== undefined) sede.nitDv = dto.nitDv || undefined;
    if (dto.tipoPersona !== undefined) sede.tipoPersona = dto.tipoPersona;
    if (dto.responsabilidadFiscal !== undefined)
      sede.responsabilidadFiscal = dto.responsabilidadFiscal;
    // Responsabilidades del RUT (ítem 1.17). El DTO las aceptaba pero no se
    // guardaban al editar: solo al crear la sede.
    if (dto.responsableIva !== undefined) sede.responsableIva = dto.responsableIva;
    if (dto.responsableInc !== undefined) sede.responsableInc = dto.responsableInc;
    if (dto.franquicia !== undefined) sede.franquicia = dto.franquicia;
    if (dto.regimenRenta !== undefined) sede.regimenRenta = dto.regimenRenta;
    if (dto.granContribuyente !== undefined)
      sede.granContribuyente = dto.granContribuyente;
    if (dto.ciiu !== undefined) sede.ciiu = dto.ciiu || undefined;
    if (dto.departamento !== undefined)
      sede.departamento = dto.departamento || undefined;
    if (dto.ciudad !== undefined) sede.ciudad = dto.ciudad || undefined;
    if (dto.emailFacturacion !== undefined)
      sede.emailFacturacion = dto.emailFacturacion || undefined;
    if (dto.resolucionFe !== undefined) {
      // Mongoose castea las fechas ISO string del DTO a Date al guardar.
      sede.set(
        'resolucionFe',
        dto.resolucionFe
          ? resolucionFeParaGuardar(String(sede._id), dto.resolucionFe, sede.resolucionFe)
          : dto.resolucionFe,
      );
    }

    if (dto.cobroDigital !== undefined) {
      const c = dto.cobroDigital;
      const next = {
        qrLlave: c.qrLlave?.trim() || undefined,
        qrImagen: c.qrImagen ? validarImagenQr(c.qrImagen) : undefined,
        qrTitular: c.qrTitular?.trim() || undefined,
        conImagen: !!c.qrImagen,
      };
      sede.set('cobroDigital', next.qrLlave || next.qrImagen || next.qrTitular ? next : undefined);
    }

    if (dto.puntosVenta !== undefined) {
      // La placa identifica la caja en el XML del POS: sin placa no es caja.
      sede.set(
        'puntosVenta',
        dto.puntosVenta
          .map((p) => ({
            placa: p.placa?.trim().toUpperCase(),
            ubicacion: p.ubicacion?.trim() || undefined,
            tipo: p.tipo?.trim() || undefined,
          }))
          .filter((p) => p.placa),
      );
    }

    if (dto.active !== undefined) sede.active = dto.active;

    await this.guardarConEmisor(sede, nitNormAntes, this.emisorDeSede?.tocaDatosFiscales(dto) === true);
    // La respuesta no devuelve la imagen del QR (~95 KB; se lee con
    // `cobroDigital()`). Ya se guardó: esto solo afecta al documento devuelto.
    if (sede.cobroDigital?.qrImagen) sede.cobroDigital.qrImagen = undefined;
    return sede;
  }

  /**
   * Emisor fiscal: se valida ANTES de guardar (un conflicto de NIT es 409 y la
   * sede no cambia) y se actualiza DESPUÉS (si falla, repetir el guardado lo
   * vuelve a intentar: se compara contra el emisor, no contra la sede vieja).
   */
  private async guardarConEmisor(
    sede: SedeDocument,
    nitNormAntes: string | undefined,
    tocaFiscal: boolean,
  ): Promise<void> {
    const sincronizarEmisor =
      tocaFiscal && this.emisorDeSede ? await this.emisorDeSede.preparar(sede, nitNormAntes) : null;
    try {
      await sede.save();
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        throw new ConflictException(`Ya existe una sede con el código ${sede.code}`);
      }
      throw err;
    }
    if (sincronizarEmisor) await sincronizarEmisor();
  }

  /**
   * Copia los datos del RUT de una sede ya configurada a otras sedes de la
   * misma empresa, para no llenar el formulario fiscal una vez por sede. Con
   * el mismo NIT y la misma identidad fiscal, cada destino queda enlazado al
   * emisor del origen y comparte con él certificado, SoftwareID, PIN y
   * domicilio fiscal.
   *
   * Se copia solo la identidad (`CAMPOS_RUT_COPIABLES`): la dirección, la
   * ciudad y el teléfono son del local y la resolución de numeración no se
   * toca (cada sede necesita su propio prefijo). Un destino que falla no
   * frena a los demás: el resultado dice qué pasó con cada uno.
   */
  async copiarDatosFiscales(origenId: string, destinos: string[]): Promise<ResultadoCopiaFiscal[]> {
    const origen = await this.findOrFail(origenId);
    if (!normalizarNit(origen.nit)) {
      throw new BadRequestException('Esta sede no tiene NIT: llena sus datos fiscales antes de copiarlos.');
    }
    const valores: Record<string, unknown> = {};
    for (const c of CAMPOS_RUT_COPIABLES) valores[c] = (origen as unknown as Record<string, unknown>)[c];
    // La razón social del emisor es `businessName` o, sin él, el nombre de la
    // sede: sin copiarla explícita, cada destino quedaría con su propio nombre.
    valores.businessName = origen.businessName || origen.name;
    const emisorOrigen = origen.emisorId ? String(origen.emisorId) : null;

    const resultados: ResultadoCopiaFiscal[] = [];
    for (const id of [...new Set(destinos)].filter((d) => d !== String(origen._id))) {
      try {
        const sede = await this.findOrFail(id);
        const nitNormAntes = normalizarNit(sede.nit);
        const s = sede as unknown as Record<string, unknown>;
        for (const [c, v] of Object.entries(valores)) s[c] = v === '' ? undefined : v;
        await this.guardarConEmisor(sede, nitNormAntes, true);
        const enlazada = !!sede.emisorId && String(sede.emisorId) === emisorOrigen;
        resultados.push({
          sedeId: id,
          nombre: sede.name,
          ok: enlazada,
          mensaje: enlazada
            ? 'Datos copiados: comparte la configuración de factura electrónica.'
            : 'Datos copiados, pero la sede aún no quedó enlazada al emisor: ábrela en el asistente para ver por qué.',
        });
      } catch (err) {
        resultados.push({
          sedeId: id,
          nombre: null,
          ok: false,
          mensaje: err instanceof Error ? err.message : 'No se pudo copiar.',
        });
      }
    }
    return resultados;
  }

  /**
   * Chequeo fiscal de las sedes: avisos que no cambian la venta, como la sede
   * marcada no responsable de INC siendo persona jurídica o con la empresa en
   * varias sedes (art. 512-13 ET, ver `advertenciasNoResponsableInc`).
   */
  async chequeoFiscal(
    scope?: string[] | null,
  ): Promise<{ sedeId: string; name: string; advertencias: string[] }[]> {
    const filter = scope ? { _id: { $in: scope } } : {};
    const [sedes, activas] = await Promise.all([
      this.sedeModel
        .find(filter)
        .select('name responsableInc franquicia tipoPersona')
        .sort({ code: 1 })
        .exec(),
      this.sedeModel.countDocuments({ active: { $ne: false } }).exec(),
    ]);
    return sedes.map((s) => ({
      sedeId: String(s._id),
      name: s.name,
      advertencias: advertenciasNoResponsableInc(s, activas),
    }));
  }

  count(): Promise<number> {
    return this.sedeModel.countDocuments().exec();
  }

  async findOrFail(id: string): Promise<SedeDocument> {
    const sede = Types.ObjectId.isValid(id)
      ? await this.sedeModel.findById(id).exec()
      : null;
    if (!sede) throw new NotFoundException('Sede no encontrada');
    return sede;
  }

  /**
   * La sede CON la clave técnica de sus resoluciones (cifrada y, si aún no se
   * migró, en claro). Solo para quien reescribe una resolución o calcula el
   * CUFE: no devuelvas `toObject()` de este documento ni lo loguees.
   */
  async findOrFailConClaves(id: string): Promise<SedeDocument> {
    const sede = Types.ObjectId.isValid(id)
      ? await this.sedeModel.findById(id).select(SELECT_CLAVES_TECNICAS).exec()
      : null;
    if (!sede) throw new NotFoundException('Sede no encontrada');
    return sede;
  }

  /**
   * Como `list`, con la clave técnica cargada: sirve para saber si existe
   * aunque la resolución sea anterior al cifrado. Mismo cuidado que arriba.
   */
  listConClaves(scope?: string[] | null): Promise<SedeDocument[]> {
    const filter = scope ? { _id: { $in: scope } } : {};
    return this.sedeModel
      .find(filter)
      .select('-cobroDigital.qrImagen ' + SELECT_CLAVES_TECNICAS)
      .sort({ code: 1 })
      .exec();
  }

  /**
   * Clave técnica de la resolución de ese tipo, descifrada, para el CUFE.
   * `undefined` si no hay. Solo servidor: nunca a una respuesta ni a un log.
   */
  async leerClaveTecnica(id: string, tipo: TipoResolucion): Promise<string | undefined> {
    const sede = await this.findOrFailConClaves(id);
    return leerClaveTecnicaDe(String(sede._id), resolucionDeTipo(sede, tipo));
  }
}
