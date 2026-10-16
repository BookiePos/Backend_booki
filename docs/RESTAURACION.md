# Restaurar una empresa desde un backup

Cada empresa vive en su propia base `biz_<businessId>`; las empresas, planes y
suscripciones viven en `bookipos_control`. Restaurar **una sola empresa** no toca a
las demás, y es el caso normal: alguien borró o dañó datos de su negocio.

> Requisito: backup continuo en Atlas (ítem 2.5, tier M10 o superior). En M0/M2/M5
> no hay snapshots ni restauración a un punto en el tiempo: este procedimiento no
> se puede ejecutar hasta subir de tier.

## Antes de empezar

1. **Confirma qué y desde cuándo.** Empresa (`businessId`), qué se perdió y la hora
   aproximada (hora de Colombia, UTC−5). Sin la hora no hay punto al que volver.
2. **Avisa al cliente** que su cuenta queda en solo lectura mientras dura la
   restauración y que lo hecho después del punto de restauración se pierde (o se
   vuelve a cargar a mano).
3. **No restaures encima de producción a ciegas.** Siempre se restaura primero a un
   cluster temporal y se compara.

## Paso a paso

1. **Restaurar a un cluster temporal.** En Atlas → *Backup* → *Restore* → *Point in
   Time* (o el snapshot más cercano), destino: un cluster nuevo `restauracion-<fecha>`
   del mismo tier. Nunca el cluster de producción.
2. **Extraer solo la base de la empresa** del cluster temporal:
   ```bash
   mongodump --uri "<URI del cluster temporal>" --db biz_<businessId> --out ./restauracion
   ```
3. **Comparar antes de reemplazar.** Contar documentos por colección en el temporal y
   en producción (`sales`, `journal_entries`, `stock_items`, `payroll_runs`…). Si la
   diferencia no explica el incidente, para ahí.
4. **Respaldar el estado actual** de esa empresa en producción, por si hay que volver:
   ```bash
   mongodump --uri "<URI de producción>" --db biz_<businessId> --out ./antes-de-restaurar
   ```
5. **Reemplazar solo esa base** en producción:
   ```bash
   mongorestore --uri "<URI de producción>" --nsInclude "biz_<businessId>.*" --drop ./restauracion
   ```
6. **No restaurar `bookipos_control`** salvo que el incidente sea del control-plane:
   ahí viven todas las empresas y sus cobros.
7. **Verificar en la app:** iniciar sesión como el dueño, revisar ventas del día del
   incidente, saldo del libro (`GET /ledger/trial-balance`) y la caja.
8. **Libro contable:** si se perdieron asientos, correr en seco
   `src/datos/2026-10-reconstruir-asientos.ts --empresa <id>` y aplicar tras revisar.
9. **Borrar el cluster temporal** y los volcados locales (tienen datos del cliente).
10. **Anotar** en `documentacion/` qué pasó, el punto restaurado y qué se perdió.

## Simulacro

Antes de vender, hacer el simulacro completo una vez con la empresa demo
(`demo@bookipos.com`): restaurar a un temporal, comparar y reemplazar. Anotar la
fecha y el tiempo que tomó en `docs/ESTADO.md`. Repetirlo cada trimestre.
