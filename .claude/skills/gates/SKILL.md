---
name: gates
description: Corre los gates del backend en un solo comando (tsc del código, tsc con los tests, vitest, eslint, higiene de secretos; y el build con --build) y devuelve solo el resumen. Úsala antes de un commit de código o de abrir un PR, o cuando el usuario pida «gates», «verifica» o «¿está verde?».
---

# Gates del backend

Un solo comando, desde la raíz del repo:

```bash
node scripts/gates.mjs           # antes de cada commit de código
node scripts/gates.mjs --build   # antes de abrir un PR: añade el build (nest/tsc a dist/)
```

El script imprime **un gate por línea**, con su cifra y su estado `OK`, `FALLA` o
`SIN MEDIR`, y deja la salida completa de cada gate en un archivo. **Lee solo ese
resumen.** Si un gate falla, abre únicamente el archivo de ese gate (las últimas ~40
líneas), no la salida entera.

Gates del backend: `tsc` del código, `tsc` con los tests (los `*.spec.ts` no los cubre
el `tsc` del código), `vitest`, `eslint`, secretos (`scripts/check-no-secrets.mjs`), y
con `--build` el build. El guardián de invariantes
(`src/shared/guards/invariantes.guard.spec.ts`: permisos, dinero, tenancy) corre dentro
de vitest.

## Reglas que hacen confiable el resultado

- **La ausencia de cifra es una falla.** Un gate que no imprime su número no corrió:
  se reporta `SIN MEDIR`, nunca verde. Casos típicos: vitest que no recolecta ningún
  test (0 de 0 no es verde), un comando que muere por la línea de comandos demasiado
  larga, un `tsc` que sale con exit≠0 y cero errores contados.
- **Reporta las cifras tal cual**, gate por gate. No resumas «todo verde» si alguna
  línea dice `SIN MEDIR`.
- **Verde unitario no es verde e2e.** Esto no dice nada del flujo real contra el
  frontend, de los datos de producción ni del despliegue. Si el cambio toca un flujo
  de usuario, hay que correr el e2e del Frontend aparte, y tras desplegar,
  `node scripts/sonda-prod.mjs`.

## Techos (`scripts/techos.json`)

Es deuda congelada: cada cuenta (p. ej. redondeos a mano por módulo) **solo puede
bajar**.

- Si tu cambio baja una cuenta, **baja el techo en el mismo PR**. Si no, la deuda que
  pagaste se puede volver a contraer sin que nadie lo note.
- Subir un techo exige **justificarlo por escrito en el PR** (por qué no hay otra
  forma). Nunca lo subas para poner un gate en verde sin decirlo.

## Triage de un test rojo

Antes de tocar una aserción, decide cuál de los dos casos es:

1. **Copy o comportamiento esperado**: el test fija un texto, una forma o un valor que
   el cambio modificó a propósito. Se actualiza esa aserción, una por una, y se dice
   en el commit por qué cambió.
2. **Regresión real**: el test detectó lo que tenía que detectar. Se arregla el
   código, no el test.

**Nunca actualices aserciones en bloque** (ni snapshots con `-u` a ciegas): es la
forma más rápida de convertir una regresión en el nuevo comportamiento «esperado».
Si un guardián de `invariantes.guard.spec.ts` se pone rojo, por defecto es regresión:
lee su mensaje antes de pensar en el techo.
