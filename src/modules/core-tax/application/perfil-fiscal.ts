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
    .select('responsabilidadFiscal')
    .exec();
  return { tipoNegocio, responsabilidadFiscal: sede?.responsabilidadFiscal };
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
  // Un restaurante (INC) no descuenta en ninguna sede: no hace falta leerlas.
  if (!porGiro) return () => false;
  const sedes = await fuentes.sedes
    .find({})
    .select('_id responsabilidadFiscal')
    .exec();
  const admite = new Map(
    sedes.map((s) => [
      String(s._id),
      admiteIvaDescontable({ tipoNegocio, responsabilidadFiscal: s.responsabilidadFiscal }),
    ]),
  );
  return (sedeId) => (sedeId ? (admite.get(sedeId) ?? porGiro) : porGiro);
}
