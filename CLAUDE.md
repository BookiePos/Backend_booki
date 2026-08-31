# BookiPos — Backend (API)

API del POS BookiPos. NestJS 10 + MongoDB (Mongoose 9) + TypeScript. Node >= 20.
Gestor de paquetes: **pnpm** (existe un `package-lock.json` residual: no lo uses).

## Comandos

| Comando | Qué hace |
|---|---|
| `pnpm dev` | Arranca en watch (`nest start --watch`), puerto `PORT` (3001 por defecto) |
| `pnpm build` | Compila con `tsc -p tsconfig.json` a `dist/` |
| `pnpm test` | Tests unitarios con vitest (`src/**/*.spec.ts`) |
| `pnpm test:watch` | Vitest en watch |
| `pnpm seed` / `seed:demo` / `seed:payroll` | Semillas (compilan antes con tsc) |
| `pnpm eval:facturas [carpeta]` | Compara los extractores de facturas (Qwen vs GLM) sobre imágenes reales |
| `pnpm lint` | **Placeholder**: hoy es `echo "TODO: eslint"`. No hay linter real todavía. |

## Invariantes no negociables

Estas tres reglas son la razón de ser de los agentes de `.claude/agents/`. Romperlas
no produce un error de compilación: produce fuga de datos entre empresas, dinero mal
calculado o un endpoint abierto.

### 1. Multi-tenancy: una base de datos por empresa

Cada negocio vive en su propia base `biz_<businessId>`. El tenant activo se propaga
con `AsyncLocalStorage` en `src/shared/tenancy/tenant-context.ts` y lo establece
`TenantMiddleware` desde el claim `biz` del JWT.

- Los modelos inyectados con `@InjectModel` son **proxies** (`model-proxy.ts`) que
  resuelven el modelo real contra la base del tenant activo **en cada acceso**.
- **Fuera de contexto el proxy es inerte** (devuelve `undefined`). Por eso nunca
  guardes un modelo en una variable de módulo, ni consultes en el constructor, ni
  en `onModuleInit`.
- Todo trabajo fuera de una request HTTP (seeds, jobs, flujos pre-auth como
  login/registro/refresh) debe abrir el contexto a mano con `TenantContext.run(...)`.
- Nunca construyas el nombre de la base a mano: usa `dbNameForBusiness(businessId)`.

### 2. Dinero: COP entero, nunca fracciones sueltas

**Ojo con la documentación heredada: el repo NO usa `Decimal128` hoy.** El enfoque real
es pragmático y está declarado en `src/modules/finance/domain/money.util.ts` y en
`src/modules/core-ledger/domain/ledger.constants.ts`: **montos en COP entero** (el peso
colombiano no usa centavos en caja), representados como `number` redondeado a peso.

- Redondea siempre con los helpers, no a mano: `cop()`, `sumCop()`, `sumBy()`,
  `clampNonNegative()` de `finance/domain/money.util.ts`.
- Nunca dejes un importe fraccionario circulando. Una división (prorrateo de
  descuentos, reparto de impuestos, propinas) debe cerrarse con `cop()` y la suma de
  las partes debe cuadrar exactamente con el total repartido.
- Nada de `parseFloat` sobre importes, ni `.toFixed(2)` para *calcular* (solo para
  mostrar).

`src/shared/money/Money.ts` (centavos en `bigint`, pensado para persistir `Decimal128`)
es un **esqueleto del scaffold**: hoy solo lo usa
`core-ledger/domain/JournalEntry.ts`. Es el destino al que se quiere migrar, no el
estado actual. No lo mezcles con el enfoque de COP entero sin migrar el módulo entero:
tener dos representaciones a medias en el mismo cálculo es peor que cualquiera de las
dos.

Invariantes del ledger que sí están vigentes: un asiento es **inmutable** (se reversa
con contra-asiento, no se edita), débitos == créditos, y todo asiento referencia el
evento que lo originó (`sourceType`/`sourceId`).

### 3. Permisos: deny-by-default

`PermissionsGuard` rechaza con 403 cualquier handler que no declare explícitamente
su política. Un endpoint nuevo sin decorar queda **cerrado**, no abierto.

Todo handler necesita exactamente uno de:
- `@RequirePermissions(PERMISSIONS.ALGO)` — el caso normal.
- `@Public()` — sin autenticación (login, health, webhooks).
- `@NoPermissionRequired()` — autenticado pero sin permiso concreto (p. ej. "mi perfil").

Los permisos viven en `src/modules/core-auth/domain/permissions.ts` como cadenas
estables `modulo.accion`. El frontend replica esa lista en `src/lib/access.ts`:
si añades o renombras un permiso, ese archivo del repo hermano queda desincronizado.

## Organización del código

```
src/
  main.ts                  arranque: helmet, cookie-parser, CORS, ValidationPipe global
  app.module.ts
  shared/
    config/  money/  storage/  tenancy/
  modules/
    core-*/                núcleo transversal (auth, audit, ledger, params, reports, tax)
    <negocio>/             sales, inventory, caja, payroll, restaurant, einvoicing, ...
```

Cada módulo sigue una separación por capas:

```
modules/<nombre>/
  application/     servicios de caso de uso + dto/ + *.spec.ts
  domain/          constantes, tipos y reglas puras (sin Nest, sin Mongoose)
  infrastructure/  controllers + schemas/ (+ guards/decorators si aplica)
  <nombre>.module.ts
```

`shared/storage/` guarda archivos públicos en Vercel Blob (fotos de productos y
facturas de compra). El token del store es de servidor: el archivo entra por el
API —multipart— y nunca se sube directo desde el navegador.

`modules/invoice-scan/` carga compras a partir de una FOTO de la factura. Dos
reglas lo gobiernan y conviene no romperlas:

- **No reimplementa el circuito de compra.** Orquesta lo que ya existe
  (`PurchasingService.create/receive` para la mercancía, `FinanceService`
  para los renglones que no son inventariables, `SuppliersService`,
  `ProductsService`). Registrar mercancía como gasto descuadra el inventario y
  duplica el costo al venderla.
- **Nada se aplica solo.** El modelo propone un borrador y una persona lo
  aprueba. `apply()` no es transaccional de punta a punta —cada servicio trae la
  suya—, así que la garantía es la idempotencia: lo ya creado queda en
  `appliedTo` y un reintento lo salta.

Qué modelo lee la foto lo decide `INVOICE_AI_PROVIDER` (qwen | glm) por una
fábrica en el módulo; el resto del código habla con la interfaz
`InvoiceExtractor` y no sabe con quién. **GLM-5.2 no acepta imágenes**: en la
implementación de Z.ai lee GLM-OCR y GLM-5.2 solo convierte ese texto en JSON.

Respeta la dirección de dependencias: `infrastructure` → `application` → `domain`.
`domain` no importa nada de Nest ni de Mongoose.

## Tests

Vitest con SWC. Los tests son **unitarios y deterministas**: instancian el servicio
directamente con dependencias mockeadas, sin DI de Nest y sin Mongo real.

Si el servicio importa esquemas, hace falta neutralizar los decoradores de
`@nestjs/mongoose` con `vi.mock` al principio del archivo (SWC emite `Object` como
metadata para uniones de literales y `SchemaFactory` revienta). Copia el patrón de
`src/modules/sales/application/orders.service.checkout.spec.ts`.

Nombra los specs `<servicio>.<caso>.spec.ts` junto al servicio que prueban.

## Convenciones

- Commits: Conventional Commits **en español** — `feat(sales): ...`, `fix(caja): ...`.
- Comentarios y mensajes de log en español. Explican el *porqué*, no el *qué*.
- Validación de entrada siempre con DTO + class-validator: el `ValidationPipe` global
  usa `whitelist` y `forbidNonWhitelisted`, así que un campo no declarado en el DTO
  hace fallar la request.
- Secretos solo por entorno. `.env.example` documenta las variables; nunca subas `.env`.
