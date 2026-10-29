import {
  datosEmisorDeSede,
  diferenciasFiscales,
  fusionarDatosEmisor,
  type DatosEmisor,
  type SedeFiscal,
} from '../modules/einvoicing/domain/emisor-fiscal';

/**
 * Plan de la migración `2026-10-emisores-desde-sedes` (lógica pura, probada en
 * `emisores-desde-sedes.spec.ts`): un emisor por NIT normalizado y cada sede
 * apuntando al suyo. Nunca elige entre datos fiscales distintos del mismo NIT:
 * ese NIT se reporta y se salta entero.
 */

export interface SedeParaPlan extends SedeFiscal {
  id: string;
  emisorId?: string;
}

export interface EmisorExistente extends Partial<DatosEmisor> {
  id: string;
  nitNorm: string;
}

export interface PlanEmisores {
  /** Sedes sin NIT utilizable: se quedan sin emisor. */
  sedesSinNit: string[];
  /** Sedes que ya apuntan a un emisor de su mismo NIT. */
  sedesEnlazadas: number;
  /** Emisores a crear, con las sedes que se enlazan a cada uno. */
  crear: { nitNorm: string; datos: DatosEmisor; sedeIds: string[]; contactoOmitido: string[] }[];
  /** Sedes a enlazar a un emisor que ya existe. */
  enlazar: { emisorId: string; nitNorm: string; sedeIds: string[] }[];
  /** NIT saltados porque sus sedes (o la sede y el emisor) no coinciden. */
  conflictos: { nitNorm: string; campos: string[]; sedeIds: string[] }[];
}

export function planificarEmisores(
  sedes: SedeParaPlan[],
  emisores: EmisorExistente[],
): PlanEmisores {
  const porId = new Map(emisores.map((e) => [e.id, e]));
  const porNit = new Map(emisores.map((e) => [e.nitNorm, e]));
  const plan: PlanEmisores = {
    sedesSinNit: [],
    sedesEnlazadas: 0,
    crear: [],
    enlazar: [],
    conflictos: [],
  };

  const pendientes = new Map<string, { id: string; datos: DatosEmisor }[]>();
  for (const sede of sedes) {
    const datos = datosEmisorDeSede(sede);
    if (!datos) {
      plan.sedesSinNit.push(sede.id);
      continue;
    }
    const actual = sede.emisorId ? porId.get(sede.emisorId) : undefined;
    if (actual && actual.nitNorm === datos.nitNorm) {
      plan.sedesEnlazadas++;
      continue;
    }
    // Sin emisor, con un emisor que ya no existe o de otro NIT (cambió el NIT).
    const grupo = pendientes.get(datos.nitNorm) ?? [];
    grupo.push({ id: sede.id, datos });
    pendientes.set(datos.nitNorm, grupo);
  }

  for (const [nitNorm, grupo] of pendientes) {
    const sedeIds = grupo.map((g) => g.id);
    const existente = porNit.get(nitNorm);
    if (existente) {
      const campos = new Set<string>();
      for (const g of grupo) {
        for (const c of diferenciasFiscales(existente, g.datos)) campos.add(c);
      }
      if (campos.size > 0) {
        plan.conflictos.push({ nitNorm, campos: [...campos], sedeIds });
      } else {
        plan.enlazar.push({ emisorId: existente.id, nitNorm, sedeIds });
      }
      continue;
    }
    const fusion = fusionarDatosEmisor(grupo.map((g) => g.datos));
    if (!fusion.ok) {
      plan.conflictos.push({ nitNorm, campos: fusion.conflictos, sedeIds });
    } else {
      plan.crear.push({
        nitNorm,
        datos: fusion.datos,
        sedeIds,
        contactoOmitido: fusion.contactoOmitido,
      });
    }
  }
  return plan;
}

/** NIT enmascarado para el log (la salida se pega en el PR). */
export function nitEnmascarado(nitNorm: string): string {
  return nitNorm.length <= 4 ? '****' : `***${nitNorm.slice(-4)}`;
}
