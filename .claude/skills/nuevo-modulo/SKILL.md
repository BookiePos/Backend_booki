---
name: nuevo-modulo
description: Crea un módulo nuevo de NestJS con la estructura por capas del repo (application/domain/infrastructure), su esquema multi-tenant, sus permisos y su registro en AppModule. Úsalo cuando haya que añadir un área funcional nueva al backend (p. ej. "crea el módulo de fidelización").
---

# Módulo nuevo en el backend de BookiPos

Un módulo mal montado aquí no falla al compilar: falla en producción por contexto de
tenant ausente o por quedar cerrado por el guard de permisos. Sigue los pasos.

## 1. Antes de escribir nada

Lee un módulo existente completo como plantilla. Elige el más parecido al que vas a
crear:

- CRUD sencillo sobre una colección → `src/modules/suppliers/` o `src/modules/customers/`
- Lógica de negocio con estado y concurrencia → `src/modules/sales/`
- Área con permisos finos y aprobaciones → `src/modules/payroll/`

## 2. Estructura obligatoria

```
src/modules/<nombre>/
  <nombre>.module.ts
  domain/
    <nombre>.constants.ts      tipos, enums y reglas puras
  application/
    <nombre>.service.ts        casos de uso
    dto/
      create-<entidad>.dto.ts
      update-<entidad>.dto.ts
    <nombre>.service.<caso>.spec.ts
  infrastructure/
    <nombre>.controller.ts
    schemas/
      <entidad>.schema.ts
```

Dirección de dependencias: `infrastructure` → `application` → `domain`.
**`domain/` no importa nada de `@nestjs/*` ni de `mongoose`.** Si necesitas un tipo de
Mongoose en domain, es señal de que la regla no era pura.

## 3. Esquema (infrastructure/schemas)

- Copia la forma de un esquema vecino: decoradores `@Schema()` / `@Prop()`,
  `SchemaFactory.createForClass`, índices declarados con `.index(...)`.
- **Importes en `Decimal128`, nunca en `Number`.** Ver `src/shared/money/Money.ts`.
- **No añadas un campo `businessId`.** El aislamiento es por base de datos
  (`biz_<businessId>`), no por columna. Un `businessId` en el documento es redundante
  y peligroso: invita a filtrar por él en vez de confiar en el tenant.
- Referencias entre colecciones solo dentro de la misma base. El control-plane
  (`src/modules/control/`) vive fuera del tenant: no lo referencies con `ref`.

## 4. Servicio (application)

- Inyecta los modelos con `@InjectModel(...)`. Recuerda que son **proxies**: resuelven
  contra la base del tenant en cada acceso.
- Nunca guardes el modelo fuera del acceso perezoso (nada de desestructurar métodos,
  variables de módulo, consultas en el constructor o en `onModuleInit`).
- Si el caso de uso corre fuera de una request (seed, job), abre el contexto con
  `TenantContext.run(...)`.
- Lanza excepciones de Nest específicas (`NotFoundException`, `ConflictException`,
  `ForbiddenException`), no `Error` genérico.

## 5. DTOs

Todo input pasa por DTO con `class-validator`. El `ValidationPipe` global usa
`whitelist: true` y `forbidNonWhitelisted: true`: un campo no declarado hace fallar la
request con 400. Declara explícitamente todo lo que aceptas.

Los importes entran como **string decimal** (`@IsDecimal` / `@Matches`), no como
`number`, para que `Money.fromDecimalString()` los reciba intactos.

## 6. Permisos (paso que más se olvida)

1. Añade los permisos al catálogo en
   `src/modules/core-auth/domain/permissions.ts`, con el formato `modulo.accion`
   (`fidelizacion.view`, `fidelizacion.manage`). Mantén el bloque comentado por área.
2. Asígnalos a los roles que corresponda en `src/modules/core-auth/domain/roles.ts`.
   Un permiso sin rol es inalcanzable.
3. Decora **cada handler** del controller con `@RequirePermissions(...)`. El guard es
   deny-by-default: un handler sin marca devuelve 403 siempre.
4. Si el área depende del plan comercial, añade `@RequireFeature(...)`.
5. Avisa al terminar de que `../Frontend/src/lib/access.ts` puede necesitar el permiso
   nuevo en `OPERATION_PERMISSIONS` si es un permiso de back-office.

## 7. Registro

Declara el módulo en `src/app.module.ts` siguiendo el orden y el estilo de los que ya
están. Registra los esquemas con el helper de tenancy que usen sus vecinos
(`src/shared/tenancy/tenant-mongoose.module.ts`), no con `MongooseModule.forFeature`
a secas, o el modelo no será multi-tenant.

## 8. Verificación antes de dar por hecho el trabajo

- `pnpm build` compila.
- `pnpm test` sigue en verde.
- Escribe al menos un spec del servicio siguiendo el estilo del repo (ver el agente
  `tester-vitest`).
- Pasa el agente `auditor-permisos` sobre el controller nuevo.
- Si el módulo toca importes, pasa también `auditor-dinero`.

## 9. Commit

Conventional Commits en español: `feat(<nombre>): ...`.
