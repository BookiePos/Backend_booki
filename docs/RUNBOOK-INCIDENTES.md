# Runbook de incidentes

Qué hacer cuando algo falla en producción. Primero se contiene, después se
investiga. Cada incidente se anota al cerrar en `documentacion/` (qué pasó, a
quién afectó, cuánto duró y qué se cambió).

## Severidad

| Nivel | Ejemplo | Respuesta |
|---|---|---|
| **S1** | El POS no cobra, nadie inicia sesión, se perdieron datos | Inmediata; avisar a los clientes |
| **S2** | Falla un módulo (nómina, compras, reportes) o una empresa | En el día |
| **S3** | Algo se ve mal o es lento, hay un camino alterno | En la semana |

## Primeros 10 minutos (S1)

1. **Confirmar:** `/estado` del sitio, `curl https://api.bookipos.com/health` y un
   login con la cuenta demo. Si solo falla una empresa, es S2.
2. **¿Hubo despliegue reciente?** Si sí, rollback sin esperar (ver `ROLLBACK.md`).
3. **Avisar a los clientes** por el canal de soporte (ver `Frontend/src/lib/soporte.ts`)
   y, si dura, que usen la contingencia de caja (`CONTINGENCIA-SIN-INTERNET.md`).
4. **Revisar Vercel:** proyecto `backend` → *Logs* (errores 5xx) y *Deployments*.
5. **Revisar Atlas:** estado del cluster, conexiones abiertas y alertas.

## Síntomas frecuentes

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| `/health` dice `db: connecting` y no pasa a `connected` tras un login | Atlas caído, IP bloqueada o credencial rotada sin actualizar `MONGODB_URI` | Atlas → Network Access y Database Access; actualizar la variable y redesplegar |
| El API no arranca tras desplegar | Falta una variable obligatoria (`JWT_SECRET`, `JWT_REFRESH_SECRET` distinta, `MONGODB_URI`) | Vercel → Settings → Environment Variables; redesplegar |
| 401 en cascada, todos deben volver a iniciar sesión | Cambio de `JWT_REFRESH_SECRET` o de `AUTH_COOKIE_DOMAIN` | Esperado tras rotar secretos; si no fue a propósito, revertir la variable |
| Cobros de suscripción sin aplicar | Webhook de Wompi rechazado o cron caído | Ver `/cron/diario` en Vercel Cron; el barrido retoma los pagos a medias |
| Ventas sin asiento contable | Fallo del libro tragado por `safePost` | `GET /ledger/conciliacion`; reconstruir con `src/datos/2026-10-reconstruir-asientos.ts` |
| El cron diario sale en rojo con «empresa(s) sin procesar por tiempo» | Demasiadas empresas para el plazo de la función | Volver a lanzarlo; si se repite, subir de plan o partir el barrido |
| Conexiones de Atlas al tope | Pool sin acotar o muchas instancias | Revisar `POOL_MONGO` y que el despliegue tenga `attachDatabasePool` |

## Al cerrar

1. Confirmar con la sonda (`node scripts/sonda-prod.mjs`) y una venta de prueba.
2. Avisar a los clientes que el servicio volvió.
3. Escribir el reporte en `documentacion/` con su fila en el índice.
4. Si hizo falta algo a mano, convertirlo en un script de `src/datos/` o en un
   arreglo con su prueba, para que no se repita.
