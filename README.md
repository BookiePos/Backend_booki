# Backend — ERP

API del ERP. **Node.js / TypeScript**, base de datos **MongoDB** (replica set). Se trabaja de forma independiente del frontend (`../frontend`), exponiendo una **API REST**.

## Estándares no negociables

- **Dinero y stock: `Decimal128`, nunca `float`.** Ver `src/shared/money`.
- **Ledger de partida doble inmutable:** todo evento de negocio genera asientos; nunca se edita, solo se reversa con contra-asiento (`src/modules/core-ledger`).
- **Transacciones:** toda operación que toca stock + dinero + ledger va en una transacción Mongo (requiere replica set).
- **Auditoría inmutable** (append-only) y **parámetros con vigencia** (nunca sobrescribir).
- **Reportes leen del ledger**, nunca de tablas operativas.
- **Multi-sede** en el modelo desde el día uno.

## Arquitectura

Hexagonal (Ports & Adapters) por módulo. Cada módulo tiene:

```
modules/<modulo>/
  domain/          # entidades, value objects, invariantes, puertos (interfaces)
  application/     # casos de uso (orquestan el dominio en transacciones)
  infrastructure/  # adaptadores: repos Mongo, controladores HTTP, drivers
```

## Módulos (orden de construcción — ver ../Orden de desarrollo v1.docx)

| Fase | Módulos |
|------|---------|
| 0 · Fundaciones | `core-auth`, `core-audit`, `core-params`, `core-tax`, `core-ledger`, `core-reports` |
| 1 · Inventario | `inventory` (BOM, multi-UoM, costeo promedio) |
| 2 · POS y Caja | `pos`, `caja` |
| 3 · Compras y Finanzas | `purchasing`, `finance` |
| 4 · Personal | `personnel` |
| 5 · Restaurante | `restaurant` |

## Stack sugerido

- Framework: **NestJS** (estructura modular alineada con hexagonal) — ver skill `nestjs-patterns`.
- ODM/ORM: **Prisma (conector MongoDB)** o **Mongoose** — ver skill `prisma-patterns`.
- Validación: DTOs + class-validator.
- Tests: TDD obligatorio en ledger, impuestos y cierre de caja (skills `tdd-workflow`, `e2e-testing`).

## Puesta en marcha (pendiente)

```bash
# 1. Levantar Mongo como replica set (requerido para transacciones)
docker compose up -d        # ver docker-patterns skill
# 2. Instalar y correr
npm install
cp .env.example .env
npm run dev
```

> Nota: el scaffold actual define estructura y estándares. La implementación se hace fase por fase con el pipeline de ECC (`orch-add-feature`).
