import 'reflect-metadata';
import { INestApplicationContext, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { BusinessService } from '../modules/control/application/business.service';
import { TenantContext } from '../shared/tenancy/tenant-context';

/**
 * Protocolo para tocar datos de producción empresa por empresa (ver docs/DATOS-PRODUCCION.md).
 *
 * Por qué existe: cada empresa vive en su base `biz_<id>` y los modelos son proxies que solo
 * resuelven dentro de `TenantContext.run`. Un script suelto que olvida abrir el contexto no
 * falla: no hace nada, o peor, lo hace contra la base equivocada. Este helper fija el orden
 * seguro para todos los scripts de datos:
 *
 *   1. EN SECO por defecto. Solo escribe con `--aplicar` explícito.
 *   2. Alcance obligatorio: `--empresa <id>` o `--todas`. Sin ninguno, no corre.
 *   3. `contar()` antes y después en cada empresa, para que el resumen muestre qué cambió.
 *   4. Un fallo en una empresa no detiene a las demás, pero sí deja el exit code en 1.
 *
 * El script que lo use debe ser IDEMPOTENTE: correrlo dos veces deja lo mismo que correrlo una.
 *
 * Ejemplo (archivo `src/datos/2026-10-normalizar-telefonos.ts`):
 *
 *   import { getModelToken } from '@nestjs/mongoose';
 *   import { Model } from 'mongoose';
 *   import { enCadaEmpresa } from './en-cada-empresa';
 *
 *   void enCadaEmpresa({
 *     nombre: 'normalizar teléfonos de proveedores',
 *     // Cuenta lo que el script pretende corregir. Tras aplicar debería quedar en 0.
 *     contar: async (app) => {
 *       const proveedores = app.get<Model<unknown>>(getModelToken('Supplier'));
 *       return { conEspacios: await proveedores.countDocuments({ phone: / / }) };
 *     },
 *     // Solo corre con --aplicar. Idempotente: el filtro ya excluye lo corregido.
 *     aplicar: async (app) => {
 *       const proveedores = app.get<Model<unknown>>(getModelToken('Supplier'));
 *       await proveedores.updateMany({ phone: / / }, [
 *         { $set: { phone: { $replaceAll: { input: '$phone', find: ' ', replacement: '' } } } },
 *       ]);
 *     },
 *   });
 *
 * Y se corre así (primero en seco, luego una empresa, luego todas):
 *
 *   pnpm build
 *   node dist/datos/2026-10-normalizar-telefonos.js --empresa <id>
 *   node dist/datos/2026-10-normalizar-telefonos.js --empresa <id> --aplicar
 *   node dist/datos/2026-10-normalizar-telefonos.js --todas
 *   node dist/datos/2026-10-normalizar-telefonos.js --todas --aplicar
 */

export type Conteo = Record<string, number>;

export interface TareaDeDatos {
  /** Qué hace el script, en una frase. Sale en el resumen. */
  nombre: string;
  /** Mide el estado de la empresa activa. Se llama antes y después. Nunca escribe. */
  contar: (app: INestApplicationContext) => Promise<Conteo>;
  /** Escribe. Solo se llama con `--aplicar`. Debe ser idempotente. */
  aplicar: (app: INestApplicationContext) => Promise<void>;
}

export interface OpcionesDeDatos {
  aplicar: boolean;
  /** Id de una empresa, o `null` para todas las activas. */
  empresa: string | null;
}

const USO =
  'Uso: node dist/datos/<script>.js (--empresa <id> | --todas) [--aplicar]\n' +
  'Sin --aplicar corre en seco: cuenta y no escribe nada.';

/** Lee los argumentos. Devuelve `null` si el alcance no es explícito. */
export function leerOpciones(argv: string[]): OpcionesDeDatos | null {
  const aplicar = argv.includes('--aplicar');
  const todas = argv.includes('--todas');
  const i = argv.indexOf('--empresa');
  const empresa = i >= 0 ? argv[i + 1] : undefined;
  if (i >= 0 && (!empresa || empresa.startsWith('--'))) return null;
  // Exactamente uno de los dos: pedir "una" y "todas" a la vez es un error de tecleo.
  if (todas === Boolean(empresa)) return null;
  return { aplicar, empresa: empresa ?? null };
}

function formatear(c: Conteo): string {
  const partes = Object.entries(c).map(([k, v]) => `${k}=${v}`);
  return partes.length > 0 ? partes.join(' ') : '(sin cifras)';
}

/**
 * Corre la tarea empresa por empresa siguiendo el protocolo. Deja `process.exitCode` en 1
 * si alguna empresa falló, y sale con 2 si el alcance no es explícito.
 */
export async function enCadaEmpresa(
  tarea: TareaDeDatos,
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  const opciones = leerOpciones(argv);
  if (!opciones) {
    console.error(USO);
    process.exit(2);
  }

  const logger = new Logger('Datos');
  const modo = opciones.aplicar ? 'APLICANDO' : 'EN SECO';
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  let fallos = 0;
  try {
    const businesses = app.get(BusinessService);
    const empresas = opciones.empresa
      ? [await businesses.findById(opciones.empresa)]
      : await businesses.listActive();
    if (empresas.length === 0 || empresas[0] === null) {
      logger.error(
        opciones.empresa ? `No existe la empresa ${opciones.empresa}.` : 'No hay empresas activas.',
      );
      process.exitCode = 1;
      return;
    }

    logger.log(`${tarea.nombre} — ${modo} — ${empresas.length} empresa(s)`);
    for (const biz of empresas) {
      if (!biz) continue;
      const businessId = biz._id.toString();
      try {
        await TenantContext.run(
          { businessId, dbName: biz.dbName, tipoNegocio: biz.tipoNegocio },
          async () => {
            const antes = await tarea.contar(app);
            if (opciones.aplicar) await tarea.aplicar(app);
            const despues = opciones.aplicar ? await tarea.contar(app) : antes;
            logger.log(
              opciones.aplicar
                ? `${businessId}: antes ${formatear(antes)} → después ${formatear(despues)}`
                : `${businessId}: ${formatear(antes)} (en seco, no se escribió nada)`,
            );
          },
        );
      } catch (err) {
        fallos++;
        logger.error(
          `${businessId}: FALLÓ — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    logger.log(
      `Resumen: ${empresas.length - fallos} bien, ${fallos} con fallo. ${
        opciones.aplicar ? '' : 'Nada escrito: repite con --aplicar cuando el conteo cuadre.'
      }`.trim(),
    );
    if (fallos > 0) process.exitCode = 1;
  } finally {
    await app.close();
  }
}
