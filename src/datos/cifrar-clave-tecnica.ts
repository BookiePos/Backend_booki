import type { Model, Types } from 'mongoose';
import {
  cifrarClaveTecnica,
  leerClaveTecnicaDe,
  SELECT_CLAVES_TECNICAS,
  type ResolucionConClave,
} from '../modules/sedes/application/clave-tecnica';
import {
  TIPO_RESOLUCION_POR_DEFECTO,
  type TipoResolucion,
} from '../modules/einvoicing/domain/resolucion-tipos';
import type { SedeDocument } from '../modules/sedes/infrastructure/schemas/sede.schema';

/**
 * Lógica de la migración `2026-11-cifrar-clave-tecnica` (probada contra un Mongo
 * real en `src/integracion/clave-tecnica.integracion.ts`): pasa la clave técnica
 * de cada resolución del campo viejo en claro (`claveTecnica`) al cifrado
 * (`claveTecnicaCifrada`) y borra el claro.
 *
 * Seguridad: aquí nada loguea ni devuelve una clave; solo conteos.
 */

interface FilaSede {
  _id: Types.ObjectId;
  resolucionFe?: ResolucionConClave | null;
  resolucionesFe?: ResolucionConClave[] | null;
}

/** Una resolución con su ruta en el documento (`resolucionFe` o `resolucionesFe.<i>`). */
interface Hueco {
  ruta: string;
  tipo: TipoResolucion;
  resolucion: ResolucionConClave;
}

export interface ConteoClaves extends Record<string, number> {
  sedes: number;
  /** Resoluciones con la clave todavía en claro: lo que el script corrige. */
  clavesEnClaro: number;
  clavesCifradas: number;
  /** Resoluciones con clave pero sin la marca `tieneClaveTecnica`. */
  sinMarca: number;
}

const tieneClaro = (r: ResolucionConClave): boolean => r.claveTecnica != null;

function huecos(sede: FilaSede): Hueco[] {
  const out: Hueco[] = [];
  if (sede.resolucionFe) {
    // La de factura es `invoice` aunque no tenga `tipoDocumento` guardado.
    out.push({ ruta: 'resolucionFe', tipo: 'invoice', resolucion: sede.resolucionFe });
  }
  (sede.resolucionesFe ?? []).forEach((r, i) => {
    if (!r) return;
    out.push({
      ruta: `resolucionesFe.${i}`,
      tipo: r.tipoDocumento ?? TIPO_RESOLUCION_POR_DEFECTO,
      resolucion: r,
    });
  });
  return out;
}

async function leer(sedes: Model<SedeDocument>): Promise<FilaSede[]> {
  // `lean` devuelve los campos tal cual están en la base; las claves vienen
  // porque se piden. Nada de esto sale de este archivo.
  return (await sedes
    .find({})
    .select(`-cobroDigital ${SELECT_CLAVES_TECNICAS}`)
    .lean()
    .exec()) as unknown as FilaSede[];
}

/** Solo lee. `clavesEnClaro` debe quedar en 0 tras aplicar. */
export async function contarClaves(sedes: Model<SedeDocument>): Promise<ConteoClaves> {
  const conteo: ConteoClaves = { sedes: 0, clavesEnClaro: 0, clavesCifradas: 0, sinMarca: 0 };
  for (const sede of await leer(sedes)) {
    conteo.sedes++;
    for (const { resolucion: r } of huecos(sede)) {
      if (tieneClaro(r)) conteo.clavesEnClaro++;
      if (r.claveTecnicaCifrada) conteo.clavesCifradas++;
      const hayClave = Boolean(r.claveTecnicaCifrada || r.claveTecnica?.trim());
      if (hayClave && !r.tieneClaveTecnica) conteo.sinMarca++;
    }
  }
  return conteo;
}

/**
 * Cifra cada clave en claro y borra el campo viejo. Idempotente: una resolución
 * ya cifrada y sin claro no se toca.
 *
 *   - El filtro de cada escritura exige que la clave en claro siga siendo la
 *     leída y que el hueco siga siendo del mismo tipo: si alguien registró otra
 *     resolución entre la lectura y la escritura, no se pisa (la siguiente
 *     corrida la recoge).
 *   - Antes de escribir se descifra lo recién cifrado y se compara: nunca se
 *     borra el claro sin haber comprobado que el cifrado se puede leer.
 *   - Si ya hay una cifrada junto al claro, manda la cifrada (es la que lee la
 *     emisión): se comprueba que descifra y solo se borra el claro.
 *   - Sin `EINVOICING_ENCRYPTION_KEY` lanza y no escribe nada.
 */
export async function cifrarClaves(
  sedes: Model<SedeDocument>,
  opciones: { env?: NodeJS.ProcessEnv } = {},
): Promise<{ cifradas: number; soloLimpiadas: number }> {
  let cifradas = 0;
  let soloLimpiadas = 0;
  for (const sede of await leer(sedes)) {
    const sedeId = sede._id.toString();
    for (const { ruta, tipo, resolucion: r } of huecos(sede)) {
      const claro = r.claveTecnica;
      const texto = typeof claro === 'string' ? claro.trim() : '';
      const set: Record<string, unknown> = {};
      const unset: Record<string, ''> = {};
      const filtro: Record<string, unknown> = { _id: sede._id };
      // En el arreglo, el índice solo vale si ahí sigue la resolución de ese tipo.
      if (ruta !== 'resolucionFe') {
        filtro[`${ruta}.tipoDocumento`] = r.tipoDocumento ?? { $exists: false };
      }

      if (claro != null) {
        filtro[`${ruta}.claveTecnica`] = claro;
        unset[`${ruta}.claveTecnica`] = '';
        if (r.claveTecnicaCifrada) {
          // Lanza si no descifra o falta la llave: el claro no se borra a ciegas.
          leerClaveTecnicaDe(sedeId, { ...r, tipoDocumento: tipo }, opciones);
          set[`${ruta}.tieneClaveTecnica`] = true;
        } else if (texto) {
          const secreto = cifrarClaveTecnica(sedeId, tipo, texto, opciones);
          const vuelta = leerClaveTecnicaDe(
            sedeId,
            { tipoDocumento: tipo, claveTecnicaCifrada: secreto },
            opciones,
          );
          if (vuelta !== texto) {
            throw new Error(`Sede ${sedeId}, ${ruta}: la clave cifrada no se pudo verificar`);
          }
          set[`${ruta}.claveTecnicaCifrada`] = secreto;
          set[`${ruta}.tieneClaveTecnica`] = true;
        }
        // Un claro vacío (o solo espacios) no es una clave: se borra sin más.
      } else if (r.claveTecnicaCifrada && !r.tieneClaveTecnica) {
        // Cifrada sin la marca: solo se completa la marca.
        filtro[`${ruta}.claveTecnicaCifrada.data`] = r.claveTecnicaCifrada.data;
        set[`${ruta}.tieneClaveTecnica`] = true;
      } else {
        continue;
      }

      const res = await sedes
        .updateOne(filtro, {
          ...(Object.keys(set).length ? { $set: set } : {}),
          ...(Object.keys(unset).length ? { $unset: unset } : {}),
        })
        .exec();
      if (res.modifiedCount === 1) {
        if (set[`${ruta}.claveTecnicaCifrada`]) cifradas++;
        else soloLimpiadas++;
      }
    }
  }
  return { cifradas, soloLimpiadas };
}
