import type { Model } from 'mongoose';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import type { BusinessType } from '../../control/domain/control.constants';
import type { SedeDocument } from '../../sedes/infrastructure/schemas/sede.schema';
import { admiteIvaDescontable, type SaleTaxProfile } from '../domain/sale-tax';

/**
 * De dónde sale el perfil fiscal: el giro es de la empresa (control-plane) y
 * la responsabilidad de IVA es de cada sede. Lo usan las compras y finanzas
 * para decidir si el IVA pagado es descontable; la venta lo arma igual.
 */
export interface FuentesPerfilFiscal {
  sedes: Model<SedeDocument>;
  businesses: { findById(id: string): Promise<{ tipoNegocio?: BusinessType } | null> };
}

/**
 * Giro del negocio activo. Lo trae el claim `biztype` del token; los tokens
 * anteriores a ese claim no lo tienen y se lee de la empresa.
 */
export async function tipoNegocioActivo(
  businesses: FuentesPerfilFiscal['businesses'],
): Promise<BusinessType | undefined> {
  const ctx = TenantContext.current();
  if (!ctx) return undefined;
  if (ctx.tipoNegocio) return ctx.tipoNegocio;
  const business = await businesses.findById(ctx.businessId);
  return business?.tipoNegocio;
}

/** Perfil fiscal de una sede de la empresa activa. */
export async function perfilFiscalDeSede(
  fuentes: FuentesPerfilFiscal,
  sedeId: string,
): Promise<SaleTaxProfile> {
  const tipoNegocio = await tipoNegocioActivo(fuentes.businesses);
  const sede = await fuentes.sedes
    .findById(sedeId)
    .select(CAMPOS_FISCALES)
    .exec();
  return perfilDe(tipoNegocio, sede);
}

/** Campos de la sede que forman su perfil fiscal (ítem 1.17). */
const CAMPOS_FISCALES = 'responsabilidadFiscal responsableIva responsableInc franquicia';

function perfilDe(
  tipoNegocio: BusinessType | undefined,
  sede: Pick<
    SedeDocument,
    'responsabilidadFiscal' | 'responsableIva' | 'responsableInc' | 'franquicia'
  > | null,
): SaleTaxProfile {
  return {
    tipoNegocio,
    responsabilidadFiscal: sede?.responsabilidadFiscal,
    responsableIva: sede?.responsableIva,
    responsableInc: sede?.responsableInc,
    franquicia: sede?.franquicia,
  };
}

/**
 * Para sumar IVA descontable de muchas sedes a la vez: devuelve si cada sede lo
 * admite. Una consulta de sedes por llamada, no una por documento. Una sede
 * desconocida (o un documento sin sede) se decide solo por el giro.
 */
export async function ivaDescontablePorSede(
  fuentes: FuentesPerfilFiscal,
): Promise<(sedeId?: string) => boolean> {
  const tipoNegocio = await tipoNegocioActivo(fuentes.businesses);
  const porGiro = admiteIvaDescontable({ tipoNegocio });
  // Cada sede se decide con su perfil: una franquicia de restaurante sí
  // descuenta IVA aunque el giro diga restaurante (ítem 1.17).
  const sedes = await fuentes.sedes
    .find({})
    .select(`_id ${CAMPOS_FISCALES}`)
    .exec();
  const admite = new Map(
    sedes.map((s) => [String(s._id), admiteIvaDescontable(perfilDe(tipoNegocio, s))]),
  );
  return (sedeId) => (sedeId ? (admite.get(sedeId) ?? porGiro) : porGiro);
}
