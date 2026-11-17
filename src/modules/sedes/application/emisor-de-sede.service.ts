import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Sede, SedeDocument } from '../infrastructure/schemas/sede.schema';
import {
  FiscalEmitter,
  FiscalEmitterDocument,
} from '../../einvoicing/infrastructure/schemas/fiscal-emitter.schema';
import {
  cambiosDeEmisor,
  datosEmisorDeSede,
  diferenciasFiscales,
  etiquetasCamposEmisor,
  fusionarDatosEmisor,
  type DatosEmisor,
  type SedeFiscal,
} from '../../einvoicing/domain/emisor-fiscal';
import { normalizarNit } from '../../einvoicing/domain/consecutivo-unico';
import type { UpdateSedeDto } from './dto/update-sede.dto';

/** Campos del DTO de la sede que alimentan al emisor fiscal. */
const CAMPOS_FISCALES_DTO = [
  'name',
  'businessName',
  'nit',
  'nitDv',
  'tipoPersona',
  'responsabilidadFiscal',
  'responsableIva',
  'responsableInc',
  'franquicia',
  'granContribuyente',
  'regimenRenta',
  'ciiu',
  'address',
  'departamento',
  'ciudad',
  'phone',
  'emailFacturacion',
] as const satisfies readonly (keyof UpdateSedeDto)[];

/** Lo mínimo de las otras sedes: ni resoluciones ni claves salen de la base. */
const CAMPOS_SEDE =
  'name businessName nit nitDv tipoPersona responsabilidadFiscal responsableIva ' +
  'responsableInc franquicia granContribuyente regimenRenta ciiu address ' +
  'departamento ciudad phone emailFacturacion';

/** Sin el NIT en claro en mensajes ni logs. */
const nitOculto = (nitNorm: string): string => (nitNorm.length <= 4 ? '****' : `***${nitNorm.slice(-4)}`);

function esLlaveDuplicada(err: unknown): boolean {
  return (err as { code?: number })?.code === 11000;
}

/**
 * Mantiene el emisor fiscal (`fiscal_emitters`, uno por NIT) al día con la
 * ficha de la sede. Antes el emisor se copiaba de la sede una sola vez (script
 * `2026-10-emisores-desde-sedes` o `asegurarParaSede`) y editar la sede no lo
 * tocaba: el XML salía con la razón social o las responsabilidades viejas.
 *
 * Mismas reglas que el script: nunca se elige entre datos fiscales distintos
 * del mismo NIT.
 *  - Sede ya enlazada a su emisor (mismo NIT): cada campo que cambió pasa al
 *    emisor solo si TODAS las sedes de ese NIT coinciden en él. Si otra sede
 *    aún tiene el valor viejo, ese campo se aplaza (no se rechaza la edición:
 *    con dos sedes del mismo NIT no habría forma de cambiar nada) y entra al
 *    guardar la última sede que faltaba. Así un usuario con acceso a una sola
 *    sede no cambia por su cuenta el emisor que comparten varias.
 *  - La sede cambia de NIT (o lo estrena): se enlaza al emisor de ese NIT si
 *    coincide en la identidad fiscal; si no coincide, 409. Si no existe, se
 *    crea con los datos fundidos de las sedes de ese NIT; si esas sedes
 *    discrepan, 409. Un emisor existente no se sobrescribe al enlazar.
 *
 * No toca credenciales, certificado, ambiente ni `habilitado`: un NIT nuevo
 * estrena emisor sin configurar.
 */
@Injectable()
export class EmisorDeSedeService {
  private readonly logger = new Logger(EmisorDeSedeService.name);

  constructor(
    @InjectModel(Sede.name) private readonly sedes: Model<SedeDocument>,
    @InjectModel(FiscalEmitter.name) private readonly emisores: Model<FiscalEmitterDocument>,
  ) {}

  /** ¿La edición toca algo que el emisor copia de la sede? */
  tocaDatosFiscales(dto: UpdateSedeDto): boolean {
    return CAMPOS_FISCALES_DTO.some((c) => dto[c] !== undefined);
  }

  /**
   * Se llama con la sede YA modificada y ANTES de guardarla: valida (409) y, si
   * cambió de NIT, deja `sede.emisorId` apuntando al emisor correcto. Devuelve
   * lo que hay que aplicar al emisor DESPUÉS de guardar la sede, o `null`.
   */
  async preparar(sede: SedeDocument, nitNormAntes: string | undefined): Promise<(() => Promise<void>) | null> {
    const datos = datosEmisorDeSede(sede as unknown as SedeFiscal);
    // Sin NIT no hay emisor: el enlace viejo ya se ignora (`obtenerPorSede`).
    if (!datos) return null;

    const hermanas = await this.sedesDelNit(datos.nitNorm, sede._id);
    const actual = sede.emisorId ? await this.emisores.findById(sede.emisorId).exec() : null;

    if (actual && actual.nitNorm === datos.nitNorm) {
      const cambios = cambiosDeEmisor(
        actual,
        datos,
        hermanas.map((h) => h.datos),
      );
      if (cambios.aplazados.length > 0) {
        this.logger.warn(
          `Sede ${String(sede._id)}: el emisor ${actual.id as string} no se actualiza en ` +
            `${cambios.aplazados.join(', ')} hasta que coincidan las ${hermanas.length} sede(s) del mismo NIT.`,
        );
      }
      const set = cambios.poner;
      const unset = Object.fromEntries(cambios.quitar.map((c) => [c, '']));
      if (Object.keys(set).length === 0 && cambios.quitar.length === 0) return null;
      const id = actual._id;
      return async () => {
        await this.emisores
          .updateOne(
            { _id: id, nitNorm: datos.nitNorm },
            { ...(Object.keys(set).length ? { $set: set } : {}), ...(cambios.quitar.length ? { $unset: unset } : {}) },
          )
          .exec();
      };
    }

    // Mismo NIT de antes y sin emisor (o con el enlace viejo): no es esta
    // edición la que lo crea; lo hace `asegurarParaSede` al configurar la FE.
    if (datos.nitNorm === nitNormAntes) return null;

    // ── La sede cambió de NIT (o lo estrena): enlazar o crear el correcto ────
    let emisor = await this.emisores.findOne({ nitNorm: datos.nitNorm }).exec();
    if (!emisor) {
      const fusion = fusionarDatosEmisor([datos, ...hermanas.map((h) => h.datos)]);
      if (!fusion.ok) {
        throw new ConflictException(
          `Otra sede con el mismo NIT (${hermanas.map((h) => h.nombre).join(', ')}) tiene datos fiscales ` +
            `distintos en: ${etiquetasCamposEmisor(fusion.conflictos)}. Son los datos del RUT: iguálalos en las ` +
            'sedes de ese NIT y vuelve a guardar.',
        );
      }
      try {
        emisor = await this.emisores.create(fusion.datos);
      } catch (err) {
        // Otra edición lo creó a la vez: vale el suyo, si coincide.
        if (!esLlaveDuplicada(err)) throw err;
        emisor = await this.emisores.findOne({ nitNorm: datos.nitNorm }).exec();
        if (!emisor) throw err;
      }
    }
    this.assertCoincide(emisor, datos);
    sede.emisorId = emisor._id;
    return null;
  }

  private assertCoincide(emisor: FiscalEmitterDocument, datos: DatosEmisor): void {
    const campos = diferenciasFiscales(emisor, datos);
    if (campos.length === 0) return;
    throw new ConflictException(
      `Ya existe un emisor fiscal con el NIT ${nitOculto(datos.nitNorm)} y sus datos no coinciden con los de esta ` +
        `sede en: ${etiquetasCamposEmisor(campos)}. Son los datos del RUT: escríbelos igual que en las otras sedes ` +
        'de ese NIT y vuelve a guardar.',
    );
  }

  /** Las OTRAS sedes con el mismo NIT normalizado (se compara normalizado: «900.123.456-7» = «900123456»). */
  private async sedesDelNit(
    nitNorm: string,
    salvo: Types.ObjectId,
  ): Promise<{ nombre: string; datos: DatosEmisor }[]> {
    const filas = (await this.sedes
      .find({ _id: { $ne: salvo }, nit: { $gt: '' } })
      .select(CAMPOS_SEDE)
      .lean()
      .exec()) as unknown as SedeFiscal[];
    const propias: { nombre: string; datos: DatosEmisor }[] = [];
    for (const f of filas) {
      if (normalizarNit(f.nit) !== nitNorm) continue;
      const datos = datosEmisorDeSede(f);
      if (datos) propias.push({ nombre: f.name ?? 'sin nombre', datos });
    }
    return propias;
  }
}
