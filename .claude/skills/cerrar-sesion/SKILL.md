---
name: cerrar-sesion
description: Cierre de sesión en punto seguro para los dos repos de BookiPos (Backend y Frontend). Corre los gates en ambos, sobrescribe Backend/docs/ESTADO.md con el estado medido, actualiza el CHANGELOG si hubo entrega, recuerda el orden de despliegue y entrega al usuario el resumen y el prompt de arranque de la sesión siguiente. Solo la invoca el usuario.
disable-model-invocation: true
---

# Cerrar sesión (checklist, en este orden, sin saltar pasos)

Cubre los dos repos hermanos: `Backend/` (esta skill vive aquí) y `../Frontend/`.
**Sin push automático y sin despliegue**: los dos son decisión del usuario.

1. **Árbol limpio de sorpresas, en ambos repos.** `git status --short` en Backend y en
   Frontend. Nada de `.env*`, llaves, volcados de base ni `.zip`. Lo que esté a medias
   se anota, no se esconde.

2. **Gates en ambos repos** (skill `gates`): `node scripts/gates.mjs` en Backend y en
   Frontend; con `--build` si lo que se cierra va a PR. Copia las líneas del resumen
   tal cual. Un gate sin cifra es `SIN MEDIR`, no verde. Si algún techo de
   `scripts/techos.json` bajó, el techo se baja en este mismo cierre.

3. **`Backend/docs/ESTADO.md` — se sobrescribe entero** (es una página, no un
   historial). Todo lo que pongas se **mide en el momento**, nunca de memoria:
   - HEAD y rama de cada repo: `git -C <repo> rev-parse --short HEAD` y
     `git -C <repo> branch --show-current`. Si hay commits sin empujar, dilo
     (`git -C <repo> status -sb`). En Backend, el commit del propio cierre solo
     toca `docs/ESTADO.md`: anota el HEAD previo y escribe «más el commit de cierre
     de ESTADO.md», para que la comprobación de la sesión siguiente no falle en falso.
   - Versión en producción de cada repo, solo si la mediste (sonda, panel del
     proveedor). Si no la mediste, escribe «sin medir».
   - Qué quedó a medias (ramas, archivos sin commitear, PR abiertos).
   - Gates al cierre: las líneas del resumen de cada repo.
   - Siguiente paso concreto (uno, accionable).
   - Hallazgos abiertos (de auditores, sonda o e2e) que nadie ha cerrado.

4. **CHANGELOG, solo si es una entrega** (algo que se va a desplegar o ya se
   desplegó): entrada en el CHANGELOG del repo afectado, en español, con lo que
   cambia para el usuario. Un cierre de trabajo interno no toca el CHANGELOG.

5. **Commit local, sin push.** Commits convencionales en español
   (`docs(estado): cierre — ...`). No ejecutes `git push`: si hace falta, se lo
   indicas al usuario.

6. **Recordatorio de despliegue** (solo si hay algo para desplegar). Orden fijo:
   **backend primero, frontend después** — el front nuevo contra un back viejo rompe
   en caliente; al revés no. Tras desplegar, `node scripts/sonda-prod.mjs` en Backend
   (`SONDA_API_URL`, `SONDA_EMAIL`, `SONDA_PASSWORD`; es de solo lectura) y anotar
   su resultado en `ESTADO.md`. Si hubo scripts de datos (`src/datos/`), recordar que
   se corren en seco primero y con `--aplicar` solo tras revisar el conteo
   (`docs/DATOS-PRODUCCION.md`).

7. **Entregar al usuario**, en el mensaje final:
   - Resumen corto: HEAD de cada repo, gates, qué quedó abierto, qué falta desplegar.
   - El **prompt de arranque de la sesión siguiente**, en un bloque listo para pegar.
     Debe pedir: leer `Backend/docs/ESTADO.md`, comprobar que el HEAD de cada repo
     coincide con el que dice ese archivo (si no coincide, parar y avisar), y seguir
     con el «siguiente paso» que quedó escrito.
