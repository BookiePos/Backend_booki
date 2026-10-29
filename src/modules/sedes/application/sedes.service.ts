import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
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
      return await this.sedeModel.create({ ...dto });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        throw new ConflictException(`Ya existe una sede con el código ${dto.code}`);
      }
      throw err;
    }
  }

  async update(id: string, dto: UpdateSedeDto): Promise<SedeDocument> {
    const sede = await this.findOrFail(id);

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
      sede.set('resolucionFe', dto.resolucionFe);
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

    if (dto.active !== undefined) sede.active = dto.active;

    try {
      await sede.save();
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        throw new ConflictException(`Ya existe una sede con el código ${sede.code}`);
      }
      throw err;
    }
    // La respuesta no devuelve la imagen del QR (~95 KB; se lee con
    // `cobroDigital()`). Ya se guardó: esto solo afecta al documento devuelto.
    if (sede.cobroDigital?.qrImagen) sede.cobroDigital.qrImagen = undefined;
    return sede;
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
}
