# Estado del proyecto

> Esta página se **sobrescribe** al cerrar cada sesión. No es un historial (para eso
> está git): es la foto de hoy. Cada cifra sale de un comando; lo que no se midió dice
> «sin medir».

**Fecha:** 2026-10-12

## Repositorios

| | Backend | Frontend |
|---|---|---|
| Rama de trabajo | `chore/metodologia` (desde `origin/main` `1fe50ce`) | `chore/metodologia` (desde `origin/main` `60ac904`) |
| Qué lleva | gates, techos, guardianes, CI, secretos, sonda, protocolo de datos, skills | gates, techos, check-permisos, CI, secretos, e2e configurable, skills |
| PR | abierto contra `main` (ver GitHub) | abierto contra `main` (ver GitHub) |

**Versión en producción:** sin medir. Córrela con `pnpm sonda` (ver `scripts/sonda-prod.mjs`)
y anota aquí el resultado.

## Qué está a medias

- **`feat/factura-electronica-apidian`** (medido tras `git fetch`, 2026-10-12): lleva 6 commits
  sobre `origin/main` en Backend y 4 en Frontend, y le falta 1 commit de `main` en cada uno.
  Cuando se mezcle, sus gates van a pedir subir techos o arreglar deuda: en `main` hay 2
  errores de lint (la rama tiene 4), `einvoicing` redondea a mano 4 veces (la rama 7) y
  `sales` 21 (la rama 22), y la rama añade el permiso `einvoicing.configure`, así que hay que
  regenerar `Frontend/scripts/permisos-backend.json` con `--actualizar`.

## Gates en `chore/metodologia` (2026-10-12)

```
Backend:  tsc-codigo 0 · tsc-tests 54 [techo 54] · vitest 857 pasan · eslint 2 [techo 2] · secretos 0  → 5/5 OK
Frontend: tsc 0 · eslint 93 [techo 93] · permisos 191 literales OK · secretos 0                     → 4/4 OK
```

El CI (`.github/workflows/ci.yml`) corre lo mismo más el build y el escaneo de secretos del
diff del PR. Su primera corrida es la de estos PR.

## Siguiente paso

1. CI verde en los dos PR de `chore/metodologia` y mezclarlos.
2. Rebasar `feat/factura-electronica-apidian` sobre el nuevo `main` y ajustar techos/permisos.
3. Atacar los hallazgos abiertos, empezando por (a): bajar `tscConTests` es la deuda que
   más miente.

## Hallazgos abiertos

**(a) Tests que pasan sin cubrir lo que dicen.** De los 54 errores de `tsc --noEmit`
(todos en specs; vitest no comprueba tipos):

- 10 × TS2554 «Expected 7 arguments, but got 6»: los specs instancian `SalesService`
  (6 archivos `sales.service.*.spec.ts`), `OrdersService` (3 archivos
  `orders.service.*.spec.ts`) y `ProductionService` (`production.service.complete.spec.ts`)
  con un argumento menos que el constructor. La dependencia que falta llega como
  `undefined`: si el camino probado la usara, el test reventaría; si pasa, es que ese
  camino no se está probando.
- 9 × TS2339 (propiedad inexistente): 4 en `delivery/application/deliveries.service.spec.ts`
  y 5 en `invoice-scan/application/invoice-scan.service.apply.spec.ts`. El test afirma
  sobre campos que el tipo ya no tiene.
- El resto son TS2532 (posible `undefined`) y afines: ruido, no mentira.

**(b) Frontend: hook después de un return temprano.**
`src/app/(secure)/panel/finanzas/gastos/page.tsx:219` llama `React.useMemo` después del
`if (!canView) return (...)` de la línea 193. Si `canView` cambia entre renders, React
ve un número distinto de hooks y la página se rompe («Rendered more hooks than during the
previous render»).

**(c) Barridos programados que probablemente nunca corren en producción.**
`billing.scheduler.ts` (espera 90 s), `einvoicing-retry.scheduler.ts` (60 s) y
`recurring-expense.scheduler.ts` (60 s) arrancan con `setTimeout` + `setInterval` en
`onModuleInit`, con `unref()`. El README dice que el API se despliega en Vercel; si corre
en funciones serverless, la instancia se congela o muere mucho antes de 60–90 s y los
barridos (cobro, reintento de factura electrónica, gastos recurrentes) no se disparan.
**Sin comprobar en producción**: revisar en los logs de Vercel si aparece alguna vez
«Barrido recurrente» o equivalente; si no, pasar a Vercel Cron llamando un endpoint
protegido.
