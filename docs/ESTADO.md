# Estado del proyecto

> Esta página se **sobrescribe** al cerrar cada sesión. No es un historial (para eso
> está git): es la foto de hoy. Cada cifra sale de un comando; lo que no se midió dice
> «sin medir».

**Fecha:** 2026-10-12

## Repositorios

| | Backend | Frontend |
|---|---|---|
| Rama de trabajo | `fix/hallazgos-estado` (desde `main` `1ba6ae8`) | `fix/hallazgos-estado` (desde `main` `a05ec26`) |
| Qué lleva | hallazgos (a) specs que compilan y (c) Vercel Cron | hallazgo (b) hook después del return temprano |
| PR | abierto contra `main` (ver GitHub) | #46 abierto contra `main` |

`chore/metodologia` ya está mezclada en `main` en los dos repos.

**Versión en producción:** sin medir. Córrela con `pnpm sonda` (ver `scripts/sonda-prod.mjs`)
y anota aquí el resultado.

## Qué está a medias

- **CRON_SECRET en Vercel (bloquea el hallazgo c).** El código ya está, pero el endpoint
  `GET /cron/diario` responde 503 hasta que el dueño defina `CRON_SECRET` en el entorno
  **Production** del proyecto `backend` (equipo `booki-pos`) en Vercel. Ningún agente toca
  esa configuración.
- **Fluid compute en Vercel: sin comprobar.** Confirmar que está activo en el proyecto
  `backend`. Sin él la función tiene un límite de 10–60 s; un corte entre la reserva del
  cobro y `wompi.createTransaction` dejaría ese período sin cobrar hasta que alguien lo note.
- **Facturación electrónica (APIDIAN): en pausa.** La rama `feat/factura-electronica-apidian`
  se borró el 2026-10-12 por decisión del dueño (no se usará todavía). Su trabajo no se perdió:
  los PR #49 (Backend) y #44 (Frontend) se mezclaron en `fix/cobros-pendientes-y-tarjeta-guardada`,
  que sigue en GitHub y **no está en `main`**. Cuando se retome, esa rama va a pedir subir techos
  o arreglar deuda (lint 4 vs 2 en `main`, `einvoicing` 7 redondeos vs 4, `sales` 22 vs 21),
  regenerar `Frontend/scripts/permisos-backend.json` (añade `einvoicing.configure`). Si trae
  barridos propios, deben engancharse a `/cron/diario` (en `main` no hay ninguno de facturación
  electrónica).

## Gates en `fix/hallazgos-estado` (2026-10-12)

```
Backend:  tsc-codigo 0 · tsc-tests 0 [techo 0] · vitest 881 pasan · eslint 2 [techo 2] · secretos 0 · build OK → 6/6 OK
Frontend: eslint techo 93 → 92 (según el commit c0747fc; los gates del Frontend los midió el otro agente)
```

## Siguiente paso

1. CI verde en los dos PR de `fix/hallazgos-estado` y mezclarlos (backend primero).
2. Dueño: definir `CRON_SECRET` en Production de Vercel (proyecto `backend`, equipo
   `booki-pos`) y redesplegar.
3. Verificar la primera ejecución del cron en el panel de Vercel (Settings → Cron Jobs →
   logs): debe responder 200 y loguear «Barridos diarios terminados en N ms». Un 500 trae
   en el cuerpo qué barrido falló (p. ej. la pasarela sin configurar).
4. Confirmar que Fluid compute está activo en el proyecto `backend`.
5. Decidir qué hacer con `fix/cobros-pendientes-y-tarjeta-guardada` (trae la facturación en pausa).

## Hallazgos

**(a) Tests que pasan sin cubrir lo que dicen — cerrado.** Los specs compilan contra el
código real: errores de `tsc` en specs 54 → 0 y techo `tscConTests` 54 → 0 (commit `bb4762c`).

**(b) Frontend: hook después de un return temprano — cerrado en código (PR Frontend #46).**
`src/app/(secure)/panel/finanzas/gastos/page.tsx`: el `useMemo` va antes del
`if (!canView) return`, y `visibleRows` se memoiza. Techo de lint del Frontend 93 → 92
(commit `c0747fc`).

**(c) Barridos programados que no corrían en producción — resuelto en código, pendiente de
`CRON_SECRET`.** En Vercel (serverless, plan Hobby: cron como mucho diario) los `setInterval`
de `BillingScheduler` y `RecurringExpenseScheduler` no corren. Ahora Vercel Cron
(`vercel.json`, `0 11 * * *` = 6:00 Bogotá) llama `GET /cron/diario`, `@Public` y protegido
por `Authorization: Bearer <CRON_SECRET>`, que corre los dos barridos en serie. En Vercel
(`process.env.VERCEL`) los schedulers no arrancan temporizadores; fuera de Vercel siguen igual.
Revisión adversarial del cambio: dos llamadas simultáneas podían cobrar dos veces la misma
renovación (ahora cada intento se reserva con un `updateOne` condicionado y la referencia es
determinista por día e intento); la espera entre reintentos bajó de 24 h a 20 h para no saltarse
el reintento diario; y el endpoint responde 500 si un barrido falla.
**Sin comprobar en producción** hasta que exista `CRON_SECRET` y se vea la primera ejecución.
