# Runbook de factura electrónica (DIAN)

Qué hace el negocio ante la DIAN y qué hace BookiPos en cada momento. Va dirigido al
dueño, al contador y a quien da soporte. Fuente: el estudio
`documentacion/ESTUDIO-FE-ALIACORP-A-BOOKIPOS.md` (Fases 0 a 10) y
`documentacion/fe-fase8-anexo-nomina.md`.

**Estado:** la factura, las notas, el POS y la nómina están construidas y se prueban con
transporte falso. Nada se ha corrido todavía contra la DIAN real: el piloto es Crunchy
Munch y depende de su .p12 y su registro. Todo lo marcado **«a confirmar en
habilitación»** son datos que solo se verifican con el set de pruebas real.

Reglas que no cambian:

- BookiPos **nunca** manda a producción un documento de pruebas ni baja a habilitación en
  silencio: producción exige emisor `habilitado` con `tipoAmbiente = 1` y resolución real.
- Una venta tiene **o** documento POS **o** factura (FEV), nunca los dos.
- Un documento ya numerado no se renumera: se reintenta el **mismo XML firmado**.
- Se cobra primero; la DIAN no frena la caja. Si tarda, el tiquete sale con CUDE y QR y
  queda pendiente.

## 1. Alta (una sola vez por NIT)

| Momento | Qué hace el negocio | Qué hace BookiPos |
|---|---|---|
| Certificado de firma | Compra el **.p12** a una entidad de certificación digital (ECD) autorizada por ONAC: tipo **persona jurídica / facturación electrónica**, entregado **en archivo .p12** (no token). Guarda la contraseña. El NIT del titular debe ser el del emisor. | Nada todavía. |
| Registro ante la DIAN | Entra al portal de habilitación de la DIAN y se registra como facturador electrónico usando **software propio** (BookiPos). Obtiene **SoftwareID**, **PIN** del software y **TestSetId** (uno por factura y otro por nómina). _A confirmar en habilitación:_ pasos exactos del portal. | Nada todavía. |
| Datos fiscales de la sede | Completa razón social, NIT con DV, municipio DANE, dirección y correo de facturación en la sede. | Crea el emisor fiscal del NIT (dos sedes con el mismo NIT lo comparten). |
| Cargar el certificado | El **Dueño** sube el .p12 y su contraseña en el detalle de la sede (tarjeta «Factura electrónica»). | Valida: abre con la contraseña, vigente, no autofirmado, uso «no repudio», sin SHA-1 y NIT del titular = NIT del emisor. Guarda el archivo en el bucket privado y la contraseña cifrada. Audita la carga o el reemplazo (`einvoicing.certificado.cargado` / `.reemplazado`). |
| SoftwareID, PIN y TestSetId | Pega los tres valores en la tarjeta «Factura electrónica» (requiere permiso `einvoicing.certificate`). Los de nómina van aparte. | Cifra el PIN (`<emisorId>:facturaPin`), no lo devuelve nunca; audita `einvoicing.factura.configurada` / `.actualizada` sin secretos. Sin la llave `EINVOICING_ENCRYPTION_KEY` responde 503 y no guarda nada. |
| Resolución y clave técnica | Solicita en el portal la **resolución de numeración** de habilitación (prefijo SETP) y después la de producción (una por tipo: factura, POS, notas). | «Traer rangos de la DIAN» (`GetNumberingRange`) trae número, rango, vigencia y **clave técnica**; también se puede teclear. Rechaza vigencias vencidas o sin fecha final. El POS y las notas exigen prefijo propio, distinto al de la factura. Audita `einvoicing.resolucion.registrada` / `.renovada` sin la clave. _A confirmar en habilitación:_ que `GetNumberingRange` responda. |
| Set de pruebas | Con la resolución de habilitación, emite los documentos que pide la DIAN por cada tipo (factura, notas, POS, nómina) hasta completar el set. | Transmite en ambiente de habilitación (`SendTestSetAsync`) y la reconsulta sigue el estado. _Pendiente:_ el set automático de FACTURA no existe; hoy se hace a mano con documentos reales de prueba. El de nómina sí tiene su tarjeta en la sede. |
| Paso a producción | Tras la aprobación del set, pide la resolución real en el portal. Registra esa resolución en BookiPos. | Soporte marca el emisor `habilitado = true` y `tipoAmbiente = 1`. El gate exige los tres (emisor habilitado, ambiente 1, resolución real). Primero con pocas ventas. |

## 2. Operación diaria

| Momento | Qué hace el negocio | Qué hace BookiPos |
|---|---|---|
| Venta normal | Cobra. Por defecto sale **documento equivalente POS** (anónimo, `222222222222`), sin tope de valor. | Reserva el número, calcula CUDE y QR, firma XAdES con el .p12, guarda el XML y transmite (`SendBillSync`). Audita la emisión (`einvoicing.documento.emitido`: número, CUFE/CUDE, tipo, actor) y cada transmisión (`einvoicing.documento.transmitido`). |
| Cliente que pide factura | Toma sus datos (nombre y documento). Si pide **factura electrónica (FEV)**, se expide FEV en vez del POS. Con el cliente identificado el POS también le soporta costos e IVA descontable. | FEV desde la venta; si la venta ya tiene POS responde 409: se anula el POS con una nota de ajuste y se factura. |
| Veredicto de la DIAN | Revisa el estado en el detalle del documento. | `accepted` solo con `IsValid = true`. `IsValid = false` queda `rejected` con los motivos en lenguaje legible. Red o timeout no cuentan como rechazo: el documento queda en vuelo (`sent`). |
| Rechazo | Corrige el dato indicado (adquiriente, NIT, etc.). | «Reintentar» reenvía **el mismo número**, nunca uno nuevo; si la DIAN dice que ya lo procesó, consulta su estado y toma ese veredicto. Requiere permiso `einvoicing.issue`. |
| Reintentos automáticos | Nada. | **Reconsulta cada 30 min** (GitHub Actions llama `GET /cron/dian-reconsulta` con `CRON_SECRET`): lo que lleve más de 10 min en `sent` se reenvía o se consulta; actor `SYSTEM` en la auditoría. Pendiente del dueño: el secret `CRON_SECRET` en GitHub (tarea 12). |
| Entregar al cliente | Puede reenviar el correo desde el detalle. | Con el documento aceptado arma el AttachedDocument firmado y el ZIP (con el PDF) y lo envía por correo **al adquiriente**; otro destino exige `einvoicing.configure` (tope 5 y 60 s). Si falta la respuesta de la DIAN, entrega solo el PDF. Descargas por URL firmada de 2 minutos. Auditado. |
| Errores en un documento aceptado | Pide la corrección. | **Nota crédito** (o de ajuste para el POS); el número original no se reutiliza. |
| Auditoría | El Dueño puede revisarla en Auditoría. | Cada emisión, transmisión (veredicto y reintento, manual o del cron), carga de certificado, cambio de credenciales, resolución, descarga, correo y **cada uso del .p12** (`einvoicing.certificado.usado`, o `.uso_fallido`). Sin secretos ni XML: solo ids, número, CUFE/CUNE, código DIAN y actor. |

## 3. Renovaciones

| Momento | Qué hace el negocio | Qué hace BookiPos |
|---|---|---|
| Certificado por vencer (cada año o según la ECD) | Compra el nuevo .p12 **antes** del vencimiento. | `/cron/diario` marca aviso a 30 días o menos y «vencido» después; el panel del certificado lo muestra. Un certificado vencido deja de firmar. |
| Reemplazo del certificado | El Dueño sube el nuevo .p12 en la misma tarjeta. | Valida el nuevo; solo si pasa reemplaza el anterior (sin perderlo antes). Audita el reemplazo con la huella anterior y la nueva. Si dos cargas chocan, gana una. |
| Resolución por agotarse o vencer | Pide la nueva resolución en el portal con anticipación. | La pantalla de resoluciones avisa por rango y vigencia. Registrar la nueva conserva la clave técnica si no llega otra y arranca en el mayor número emitido + 1. Audita `einvoicing.resolucion.renovada`. |

## 4. Contingencia

**Aún no construida (Fase 9 del estudio).** Hoy, si la DIAN no responde, el documento
queda en vuelo (`sent`) y la reconsulta lo reenvía; no hay modo de contingencia 03/04.

- Sin internet en la caja: seguir `docs/CONTINGENCIA-SIN-INTERNET.md` (talonario de papel
  y digitación al volver la conexión).
- Norma (Res. 165/2023 art. 37, compilada en la 227/2025): transmitir dentro de las
  **48 horas** desde que se restablece el servicio, sea falla de la DIAN o del negocio.
  Las notas y la nómina no tienen contingencia: esperan a que vuelva el servicio.
  - **Cola de notas y nómina.** Si la DIAN no responde (red, timeout o cualquier código
    sin veredicto), la nota crédito/débito o el documento de nómina queda firmado y en
    cola (`sent`, o `signed` con su XML si no alcanzó a salir). La reconsulta
    (`GET /cron/dian-reconsulta`, cada 30 min) reenvía el **mismo XML firmado**, con el
    mismo número, hasta que haya veredicto; si la DIAN responde «ya procesado» consulta
    `GetStatus`. Nunca se re-firma con tipo 03/04 ni se renumera, y no hay tope de
    reintentos. El detalle lo muestra como «En cola» (`enCola` y `estadoResumen`).
- _A confirmar:_ cómo se numerarán y re-firmarán los documentos de contingencia cuando se
  construya la Fase 9.

## 5. Nómina electrónica (mensual)

Un documento por trabajador y por mes, con el mismo .p12 pero con el **SoftwareID, PIN y
TestSetId de nómina** (distintos de los de factura).

| Momento | Qué hace el negocio | Qué hace BookiPos |
|---|---|---|
| Habilitación de nómina | Se registra en el portal para nómina y pega SoftwareID, PIN y TestSetId de nómina en la sede. | Cifra el PIN; la tarjeta de la sede corre el set de habilitación de nómina. Pendiente del dueño: el .p12 y el TestSetId del piloto (tarea 8). |
| Cierre del mes | Cierra la corrida de nómina; la nómina electrónica depende de las **colillas con asistencia** (sin turnos, salen en cero). | Una colilla por trabajador; si un trabajador sale en dos corridas del mismo mes, se bloquea. |
| Revisar | En `/panel/nomina/electronica` revisa el mes: qué trabajadores están listos y qué datos faltan (tipo y número de documento, contrato, correo, municipio, medio de pago, etc.). | «Preparar» valida el pre-vuelo y cuadra devengados y deducciones contra la colilla. Sin pagos ni abonos en el mes no hay documento. |
| Emitir | Emite **dentro de los 10 primeros días hábiles del mes siguiente** (Res. 13/2021, compilada en la 227/2025; _el artículo exacto: a confirmar_). _Pendiente: BookiPos aún no avisa del plazo._ | Emite por lotes de 3 (40 s), firma, transmite y calcula el CUNE; audita `einvoicing.nomina.periodo.emitida` y por documento. |
| Rechazo | Corrige el dato del trabajador y reintenta. | Se reenvía con el **mismo número**, sin nota. |
| Ajustes (tipo 103) | Si cambia algo después de aceptado (corrida recalculada, prima o liquidación que aparece tarde, dato del trabajador): **Reemplazar**. Si el documento no debió existir (duplicado, mes o NIT equivocado, contratista): **Eliminar**. | Una corrida cerrada no se reabre; la nota se pide a mano con «Corregir (reemplazar)» o «Eliminar» en `/panel/nomina/electronica`. Reemplazar envía el documento completo con número nuevo; Eliminar solo la cabecera con totales en cero. 409 si cambió la identidad o el NIT (se elimina y se emite uno nuevo). |
| Riesgo | Emitir a tiempo: el costo en renta depende de la transmisión; la extemporaneidad aún no tiene sanción reglamentada (art. 616-1 ET). Corregir antes de declarar renta evita desconocer el costo (Concepto 1239/2024). | — |

Preguntas abiertas de nómina (dueño y habilitación): prima y cesantías pagadas por fuera,
novedades (vacaciones, incapacidades), liquidación de retiro, aprendices y contratistas,
empleador por NIT de sede (tarea 11 del dueño); **a confirmar en habilitación**:
pasaporte y PPT, predecesor en notas encadenadas, `SegundoApellido` vacío, porcentajes de
recargos de la Ley 2466. Detalle en `documentacion/fe-fase8-anexo-nomina.md` §8.

## 6. Qué mirar cuando algo falla

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| `CONFIG_FALTANTE` y nada sale a la red | Falta .p12 vigente, SoftwareID o PIN. | Completar la tarjeta «Factura electrónica» (o la de nómina). |
| 503 al guardar el PIN o cargar el .p12 | Falta o está mal `EINVOICING_ENCRYPTION_KEY`. | Avisar a soporte; no se guardó nada. |
| Documento en `sent` mucho tiempo | DIAN lenta o red; el cron no corre. | Reintentar desde el detalle; revisar que el workflow `dian-reconsulta` tenga `CRON_SECRET`. |
| `rejected` | Veredicto de la DIAN. | Leer los motivos, corregir y reintentar con el mismo número. |
| Fila `einvoicing.certificado.uso_fallido` | Sin certificado, sin llave de cifrado o el bucket no respondió. | Revisar la tarjeta del certificado y la llave; recargar el .p12 si hace falta. |
| 409 al emitir FEV o POS | La venta ya tiene el otro tipo. | Anular con nota de ajuste y emitir el correcto. |

## 7. Presupuesto de tiempo por llamada

La función de Vercel (toda la API es una sola, preset NestJS con Fluid compute) dura como
máximo **300 s**: es el valor por defecto y el máximo del plan Hobby con Fluid; en Pro el
máximo sube a 800 s. No se declara en `vercel.json`: con el preset NestJS la clave
`functions` no empareja ninguna función y el build falla. Se fija en el panel de Vercel
(Settings → Functions → Advanced Settings → Function Max Duration) y se comprueba con
`vercel inspect <url> --json` (campo `timeout`). La cifra vive en
`src/shared/config/duracion-funcion.ts` y su test hace las cuentas de esta tabla.

| Llamada | Presupuesto | De dónde sale |
|---|---|---|
| Una llamada SOAP a la DIAN | 8 s (tope duro 25 s) | `PRESUPUESTO_POR_DEFECTO_MS` del cliente; `PRESUPUESTO_RED_MAX_MS` corta aunque el cliente no responda. |
| Cobro en caja (POS) | 4 s de espera | `PLAZO_POR_DEFECTO_MS`; pasado el plazo responde `en_proceso` y la transmisión sigue detrás de la respuesta (`waitUntil`). |
| Emisión o reintento de un documento | 16 s normal (envío + `GetStatus`); 42 s si la DIAN no responde (3 envíos con 5 s) | Tope duro: 50 s y 110 s. Las notas y la nómina hacen un solo envío. |
| Nómina del periodo | 40 s por llamada, con cursor | `PRESUPUESTO_EMISION_MS`. |
| Sets de habilitación | 45 s por corrida | `PRESUPUESTO_CORRIDA_MS`, `PRESUPUESTO_CORRIDA_FACTURA_MS`. |
| Cron de reconsulta y cron diario | 240 s para empezar trabajo | `PLAZO_BARRIDOS_MS`; no empieza un documento con menos de 60 s (`MARGEN_PLAZO_RECONSULTA_MS`), así el último termina antes de los 300 s. El workflow corta a los 290 s. |
| Bloqueo de un documento | 330 s | `BLOQUEO_TRANSMISION_MS`: más que la función, para que nadie lo tome mientras otra llamada sigue viva. |

Sin Fluid compute el plan Hobby solo da 60 s: el cobro y la emisión seguirían cabiendo,
los dos crons no. No apagar Fluid sin rehacer los barridos.
