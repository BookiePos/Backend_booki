# Estado del proyecto

> Esta página se **sobrescribe** al cerrar cada sesión. No es un historial (para eso
> está git): es la foto de hoy. Cada cifra sale de un comando; lo que no se midió dice
> «sin medir».

**Fecha:** 2026-10-17

## Repositorios

| | Backend | Frontend |
|---|---|---|
| Rama base | `main` en `422d44d` | `main` en `6d8cea6` |
| Trabajo abierto | #71 (auditoría de seguridad 4.11) y esta rama (2.13) | ver GitHub |

**Versión en producción:** sin medir. Córrela con `pnpm sonda` (o mira el resumen de la
GitHub Action `sonda-prod`, que imprime el commit) y anótala aquí al cerrar la sesión.

## Operación

- **Runbook:** `docs/RUNBOOK-INCIDENTES.md`. **Tablero y alertas:** `docs/TABLERO-SALUD.md`.
- **Monitoreo (Sentry):** código en producción; activo solo con `SENTRY_DSN`. Sin medir si el
  dueño ya lo configuró (tarea 3 de `documentacion/tareas-del-dueno.md`).
- **Cron diario:** `GET /cron/diario` a las 11:00 UTC; responde 500 si un barrido falla.
  Última ejecución con 200: sin medir (requiere logs de Vercel Pro).
- **Sonda:** `sonda-prod` corre tras cada despliegue; falta que el dueño cargue sus secretos.

## Qué está a medias (depende del dueño)

Vercel Pro (2.1, 2.2), Atlas M10 (2.5, 2.6), Sentry y su tablero (2.4, 2.13), secretos de la
sonda (2.8) y datos de soporte (2.12, 7.3). Pasos en `documentacion/tareas-del-dueno.md`.

## Gates (2026-10-17, en la rama de 2.13)

```
vitest src/shared/monitoreo: 15 pasan · tsc --noEmit 0 errores · eslint de lo tocado 0
```
El resto de gates (`node scripts/gates.mjs`) corre en CI; no se midió en local.

## Cómo mantener esta página

Al cerrar cada sesión: actualizar fecha, ramas/PR, versión en producción (de la sonda) y los
resultados de gates. Si una cifra no se midió, escribir «sin medir».
