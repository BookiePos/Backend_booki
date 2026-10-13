# Datos de producción: cómo se tocan

Cada empresa vive en su propia base `biz_<id>`. Un cambio de datos mal hecho no se
nota en el momento: aparece semanas después como un saldo que no cuadra en una sola
empresa. Por eso hay un único camino para corregir o migrar datos.

## Reglas

1. **Nunca a mano.** Nada de `updateMany` en la consola de Mongo, Compass o Atlas, ni
   scripts pegados en una terminal. Lo que no está versionado no se puede revisar,
   repetir ni deshacer.
2. **Script versionado e idempotente.** Va en `src/datos/<fecha>-<qué-hace>.ts`, entra
   por PR como cualquier código y usa `enCadaEmpresa()` de
   `src/datos/en-cada-empresa.ts`. Correrlo dos veces deja lo mismo que correrlo una:
   el filtro del `aplicar` excluye lo ya corregido.
3. **Primero en seco, luego una empresa, luego todas.** Sin `--aplicar` el script solo
   cuenta. Sin `--empresa <id>` o `--todas` no corre.
4. **Contar antes y después.** `contar()` mide lo que el script pretende cambiar; el
   resumen muestra `antes → después` por empresa. Si el «después» no es el esperado,
   paras ahí.
5. **Dinero y ledger no se editan.** Un asiento es inmutable: se corrige con un
   contra-asiento a través del servicio, nunca reescribiendo el documento. Los montos
   pasan por `cop()` / `sumCop()` (ver `CLAUDE.md`, invariante 2).

## Paso a paso

```bash
pnpm build

# 1. En seco sobre una empresa: ¿el conteo tiene sentido?
node dist/datos/2026-10-normalizar-telefonos.js --empresa <id>

# 2. Aplicar en esa empresa y revisar el antes → después (y la app, a mano).
node dist/datos/2026-10-normalizar-telefonos.js --empresa <id> --aplicar

# 3. En seco sobre todas: ¿alguna empresa da un número raro?
node dist/datos/2026-10-normalizar-telefonos.js --todas

# 4. Aplicar en todas.
node dist/datos/2026-10-normalizar-telefonos.js --todas --aplicar
```

`--todas` recorre las empresas en estado `trial` o `active` (`BusinessService.listActive`).
Una suspendida o cancelada solo se toca con `--empresa <id>`.

Si una empresa falla, las demás siguen y el proceso sale con código 1. Como el script
es idempotente, corregir la causa y repetir es seguro.

## Plantilla

El ejemplo completo está comentado en la cabecera de `src/datos/en-cada-empresa.ts`.
Lo mínimo:

```ts
import { enCadaEmpresa } from './en-cada-empresa';

void enCadaEmpresa({
  nombre: 'qué hace, en una frase',
  contar: async (app) => ({ pendientes: 0 }), // solo lee
  aplicar: async (app) => {},                 // solo con --aplicar; idempotente
});
```

Usa los servicios o los modelos que te da `app.get(...)`: dentro de `contar` y
`aplicar` ya está abierto el `TenantContext` de la empresa, así que los proxies de
`@InjectModel` apuntan a su base. No construyas el nombre de la base a mano.

## Qué queda en el PR

- El script, con su fecha y una línea de por qué existe.
- La salida del paso 1 y del paso 3 (en seco), pegada en la descripción.
- Tras aplicarlo, la salida del paso 4 en un comentario del PR.
