import type { INestApplicationContext } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { enCadaEmpresa } from './en-cada-empresa';
import { cifrarClaves, contarClaves } from './cifrar-clave-tecnica';
import { Sede, type SedeDocument } from '../modules/sedes/infrastructure/schemas/sede.schema';

/**
 * Por qué existe (checklist 1, Fase 1, «Resoluciones por tipo de documento»): la
 * clave técnica de las resoluciones (`resolucionFe` y `resolucionesFe[]` de cada
 * sede) se guardaba en claro. Desde este cambio se guarda cifrada en
 * `claveTecnicaCifrada`; este script pasa las que ya existían y borra el claro.
 *
 *   - En seco: cuenta las claves en claro (`clavesEnClaro`), las ya cifradas y
 *     las que no tienen la marca `tieneClaveTecnica`. No escribe.
 *   - Con `--aplicar`: cifra, comprueba que lo cifrado se lee, borra el claro y
 *     pone la marca. Idempotente: repetirlo no cambia nada.
 *   - Nunca imprime una clave: solo conteos.
 *
 * ANTES DE APLICAR:
 *   1. El backend que LEE el campo cifrado ya tiene que estar desplegado: el
 *      código anterior solo conoce el claro y dejaría de poder emitir.
 *   2. `EINVOICING_ENCRYPTION_KEY` de esta terminal tiene que ser LA MISMA de
 *      Vercel. Con otra llave todo queda cifrado con algo que producción no
 *      puede leer, y el claro ya no existe. Sin llave, `--aplicar` falla sin
 *      escribir nada.
 *
 *   pnpm build
 *   node dist/datos/2026-11-cifrar-clave-tecnica.js --empresa <id>
 *   node dist/datos/2026-11-cifrar-clave-tecnica.js --empresa <id> --aplicar
 *   node dist/datos/2026-11-cifrar-clave-tecnica.js --todas
 *   node dist/datos/2026-11-cifrar-clave-tecnica.js --todas --aplicar
 */

const sedes = (app: INestApplicationContext) =>
  app.get<Model<SedeDocument>>(getModelToken(Sede.name));

void enCadaEmpresa({
  nombre: 'cifrar la clave técnica de las resoluciones y borrar la que está en claro',
  contar: (app) => contarClaves(sedes(app)),
  aplicar: async (app) => {
    await cifrarClaves(sedes(app));
  },
});
