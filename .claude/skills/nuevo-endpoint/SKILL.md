---
name: nuevo-endpoint
description: Añade un endpoint a un módulo existente con su DTO, su permiso, su guard y su cliente en el frontend. Úsalo cuando haya que exponer una operación nueva de la API (p. ej. "añade un endpoint para anular un traslado de inventario").
---

# Endpoint nuevo en la API de BookiPos

El error más común no es de código: es olvidar el decorador de permiso y que el
endpoint devuelva 403 en producción, o exponerlo de más con `@NoPermissionRequired()`.

## 1. Ubicación

El handler va en `src/modules/<modulo>/infrastructure/<modulo>.controller.ts`.
La lógica va en `application/<modulo>.service.ts`. **El controller no lleva lógica de
negocio**: valida, delega y devuelve.

## 2. Contrato de entrada

- Body o query → DTO en `application/dto/`, con `class-validator`.
- El `ValidationPipe` global usa `whitelist` y `forbidNonWhitelisted`: cualquier campo
  no declarado en el DTO hace fallar la request con 400. Declara todo lo que aceptas.
- Importes como **string decimal**, nunca `number`. Los recibe
  `Money.fromDecimalString()`.
- IDs de Mongo validados (`@IsMongoId()`), no strings libres.

## 3. Política de acceso (obligatorio, sin excepciones)

`PermissionsGuard` es deny-by-default. Elige **una**:

| Caso | Decorador |
|---|---|
| Operación de negocio (lo normal) | `@RequirePermissions(PERMISSIONS.X)` |
| Sin autenticación (login, health, webhook) | `@Public()` |
| Autenticado, recurso propio del usuario | `@NoPermissionRequired()` |

Reglas de criterio:
- Lectura → permiso `*.view`. Escritura → `*.manage` (o el específico:
  `pos.void.authorize`, `payroll.deduction.approve`).
- Si el permiso no existe todavía, añádelo a
  `src/modules/core-auth/domain/permissions.ts` **y** asígnalo a algún rol en
  `roles.ts`, o quedará inalcanzable.
- `@Public()` en un endpoint que toca datos de tenant es un bug: corre sin contexto de
  empresa.
- Si el endpoint devuelve datos por sede, filtra por los `sedeIds` del usuario o exige
  `SEDE_VIEW_ALL`. Ver `src/modules/core-auth/domain/sede-access.ts`.
- Si el acceso depende del plan comercial, añade `@RequireFeature(...)`.

El usuario autenticado se obtiene con `@CurrentUser()` (tipado `JwtUser`), no leyendo
`request.user` a mano.

## 4. Multi-tenancy

No recibas `businessId` por parámetro para elegir datos: sale del JWT y lo resuelve
`TenantContext`. Un `businessId` en el body es acceso cross-tenant.

## 5. Errores

Excepciones de Nest con mensaje en español y, cuando el frontend deba distinguirlo,
un código estable en la respuesta (el patrón existe: ver `ACCOUNT_SUSPENDED` en
`src/modules/billing/` y su consumo en `../Frontend/src/lib/api.ts`).

## 6. Cliente en el frontend

Si el endpoint lo va a consumir la app, el cliente vive en el repo hermano, en
`Frontend/src/lib/erp/api-<modulo>.ts`. Hay un archivo por módulo del backend: respeta
esa correspondencia. Menciónalo al terminar aunque no lo edites tú.

## 7. Verificación

- `pnpm build`.
- Un spec del servicio que cubra el camino feliz y al menos un error esperado.
- Pasa el agente `auditor-permisos`: debe ver el endpoint nuevo con política declarada.
- Prueba manual con la API levantada (`pnpm dev`, health en `/health`).

## 8. Commit

`feat(<modulo>): ...` o `fix(<modulo>): ...`, en español.
