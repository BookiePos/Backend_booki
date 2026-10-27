# Tablero de salud

Qué se mira, dónde y cuándo se avisa. Es la parte «medible» de la operación (ítem 2.13):
errores, latencia del POS, cron y cobros. Las alertas de abajo se crean una sola vez en
Sentry (ver `documentacion/tareas-del-dueno.md`, tarea 3); el código ya manda lo necesario.

## Qué reporta el código

| Señal | De dónde sale | Etiqueta en Sentry |
|---|---|---|
| Errores 5xx del API | `SentryExceptionFilter` | `ruta` (plantilla, p. ej. `/sales/:id`), `metodo` |
| Fallo del cron diario | `/cron/diario` responde 500 si un barrido falla | `ruta_critica = cron-diario` |
| Fallo de cobros (webhook de Wompi) | `/billing/webhook` | `ruta_critica = billing-webhook` |
| Latencia por ruta | Trazas de Sentry, si `SENTRY_TRACES_SAMPLE_RATE` > 0 | transacción = ruta |
| Disponibilidad y tiempos | `pnpm sonda` tras cada despliegue (GitHub Actions) | línea por paso, con ms |

`SENTRY_TRACES_SAMPLE_RATE` (0 a 1) va en Vercel, proyecto `backend`, solo Production. Con
`0.1` se mide el 10 % de las peticiones; sin la variable no se mide latencia y el costo es cero.

## Widgets del tablero (Sentry → Dashboards → Create)

| Widget | Consulta | Para qué |
|---|---|---|
| Errores por hora | Issues/Errors, `environment:production`, agrupado por `ruta` | Ver picos y qué ruta los causa |
| Latencia del POS (p95) | Transactions, `transaction:/sales*`, `p95(transaction.duration)` | Cobrar debe ser rápido |
| Latencia de login (p95) | Transactions, `transaction:/auth/login`, `p95` | Entrar al turno |
| Cron diario | Errors, `ruta_critica:cron-diario` | Si hay algo aquí, el barrido falló |
| Cobros | Errors, `ruta_critica:billing-webhook` | Cobros de suscripción que no se aplicaron |

## Umbrales y alertas

| Alerta | Condición | Severidad (ver `RUNBOOK-INCIDENTES.md`) |
|---|---|---|
| Cron diario falla | Un issue nuevo con `ruta_critica:cron-diario` | S2 |
| Cobros fallan | Un issue con `ruta_critica:billing-webhook` visto más de 1 vez en 1 h | S2 |
| Ráfaga de errores | Más de 20 errores en 10 min en Production | S1 si afecta `/sales` |
| POS lento | p95 de `/sales*` por encima de 1500 ms durante 15 min | S3 (S2 si pasa de 4000 ms) |
| Sonda roja | La GitHub Action `sonda-prod` termina en rojo | S1 hasta confirmar |

## Revisión

- Tras cada despliegue: la sonda; anotar la versión en `docs/ESTADO.md`.
- Cada lunes: abrir el tablero, mirar errores y p95 de la semana y comparar con la anterior.
- Cada incidente: seguir `RUNBOOK-INCIDENTES.md` y dejar el reporte en `documentacion/`.
