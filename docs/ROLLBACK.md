# Volver a la versión anterior (rollback)

Backend (`backend`) y Frontend (`frontbooki`) se despliegan en Vercel desde `main`.
El orden de despliegue es **backend primero, frontend después**; el rollback va al
revés: **frontend primero, backend después**, para que nunca quede un frontend nuevo
hablando con un backend viejo que no conoce sus llamadas.

## Cuándo

- La sonda de producción (`node scripts/sonda-prod.mjs`) falla después de desplegar.
- Errores 5xx sostenidos, el POS no cobra o el login no funciona.
- No esperes a entender la causa: primero se vuelve atrás, después se investiga.

## Paso a paso (Instant Rollback)

1. **Frontend.** Vercel → proyecto `frontbooki` → *Deployments* → el último despliegue
   de producción que funcionaba → *Instant Rollback*. O por CLI:
   ```bash
   npx vercel --scope booki-pos rollback <url-del-despliegue-bueno>
   ```
2. **Backend.** Lo mismo en el proyecto `backend`.
3. **Verificar:** `node scripts/sonda-prod.mjs` (desde `Backend/`) y una venta de
   prueba en la empresa demo.
4. **Variables de entorno:** Instant Rollback NO revierte variables. Si el despliegue
   malo cambió una variable (p. ej. `JWT_REFRESH_SECRET`), hay que restaurarla a mano
   y volver a desplegar.
5. **Datos:** Instant Rollback tampoco revierte datos. Si el despliegue malo escribió
   datos, se corrigen con un script de `src/datos/` (ver `DATOS-PRODUCCION.md`) o se
   restaura la empresa (ver `RESTAURACION.md`).
6. **Arreglar en `main`:** revertir el PR con `git revert -m 1 <merge>` en una rama,
   PR y merge. Mientras `main` tenga el commit malo, el siguiente push lo vuelve a
   desplegar.
7. **Anotar** en `docs/ESTADO.md` qué se revirtió y por qué.

## Cambios con datos o contratos

Antes de mezclar un cambio que altera el contrato de la API (como el refresh token
solo en cookie) o que requiere migrar datos, anotar en el PR si el rollback es
seguro. Si no lo es, el plan B es un arreglo hacia adelante, no un rollback.
