# Vender sin internet (contingencia de caja)

BookiPos funciona en línea: sin conexión el POS no registra ventas. Mientras no
exista el modo offline (ítem 6.3), este es el plan para que el negocio no deje de
vender. Va dirigido al cajero y al dueño; conviene imprimirlo y dejarlo en la caja.

## Cuando se cae el internet

1. **No cierres la pestaña del POS** ni el turno de caja: al volver la conexión se
   sigue en el mismo turno.
2. **Prueba el plan B de conexión:** datos del celular compartidos (hotspot). En la
   mayoría de los casos basta para seguir vendiendo.
3. **Si no hay forma de conectarse, venta manual:**
   - Usa el talonario de **comprobantes de contingencia** (numerados, en papel).
   - Anota en cada uno: número, hora, productos, cantidades, precio, medio de pago y,
     si hay propina o domicilio, aparte.
   - Cobra en efectivo o con datáfono independiente. **No fíes** durante la
     contingencia: el fiado necesita el sistema para validar al cliente.
   - Guarda los comprobantes en un sobre por turno.

## Cuando vuelve la conexión

1. **Digita las ventas manuales** en el POS, en el orden del talonario, en el mismo
   turno de caja. En cada comprobante de papel anota el número que el sistema le dio
   a la venta, así cada papel queda enlazado a su registro.
2. **Cuadra:** la suma de los comprobantes debe ser igual a lo registrado. El arqueo
   del turno se hace después de digitar todo.
3. **Inventario:** las ventas digitadas descuentan stock al registrarse; si algo se
   vendió sin existencia en el sistema, se ajusta después con un ajuste de inventario.
4. **Documento electrónico (Fase 9, contingencia del facturador 07/03):** cada venta
   que se hizo sin BookiPos necesita su documento electrónico **dentro de las 48 horas**
   siguientes a que vuelva el servicio (art. 37 Res. 165/2023):
   - Las ventas del **modo sin conexión** del POS se transcriben solas al sincronizar:
     POS **07** (o factura **03** si el cliente la pidió), con la numeración de
     contingencia de la sede, la fecha real de la venta y la referencia a su número.
     Si no se puede (falta la numeración de contingencia o el PIN), quedan pendientes y
     se transcriben con `POST /sales/:id/contingencia/transcribir`.
   - Las ventas del **talonario de papel** se digitan y se transcriben con el mismo
     endpoint, indicando el número impreso, la fecha y (si la tiene) la hora del papel
     (`{ "talonario": { "numero": 7, "fecha": "2026-11-04", "hora": "09:30" } }`). El
     documento electrónico lleva la fecha del papel. Opcional: `superadaAt`, cuándo se
     superó la falla (desde ahí corren las 48 h; por defecto, ahora).
   - **Numeración:** el talonario usa la numeración de contingencia desde el **principio**
     del rango; las ventas sin conexión toman números desde el **final** del rango hacia
     atrás. Así un papel ya entregado nunca choca con una venta sin conexión.
   - Las devoluciones, rebajas o anulaciones que se hicieron antes de transcribir se
     emiten en ese momento, en orden y contra el documento transcrito.
   - BookiPos transmite el documento y después sus notas (cron de reconsulta cada
     30 min o `POST /einvoicing/documentos/:id/contingencia/transmitir`). La alerta del
     cron diario avisa lo que está por vencer.
   - Requisito: registrar en Resoluciones la **numeración de contingencia** que autoriza
     la DIAN (tipo «Contingencia»).
   - **Aviso a la DIAN (lo hace el negocio, no BookiPos):** en la falla del facturador,
     el negocio informa la contingencia por correo a
     **contingencia.facturadorvp@dian.gov.co**, con una carta firmada por el
     **representante legal** que diga qué falló, desde cuándo y qué numeración de
     contingencia usó (anexo DE §15; art. 37 Res. 165/2023). _Pendiente de confirmar
     con el contador el contenido y el plazo del aviso._
5. **Si la que falla es la DIAN (04/08):** no hay que hacer nada en la caja. BookiPos
   reintenta tres veces; si la DIAN no responde, el documento queda expedido en
   contingencia con el mismo número y CUDE/CUFE (el tiquete impreso sigue valiendo) y se
   transmite solo cuando la DIAN vuelva, dentro de las 48 horas. La factura 04 se le
   entrega al cliente en ese momento (PDF y XML firmado; por correo si tiene); cuando la
   DIAN la acepta, se rehace la entrega con el AttachedDocument. Si la DIAN resulta haber
   recibido el original durante la caída, la contingencia no aplica y queda vigente el
   XML original.

## Antes de que pase

- Tener el talonario de contingencia impreso y numerado en cada caja.
- Tener un plan de datos móviles disponible para el hotspot.
- Probar una vez al mes: apagar el Wi-Fi, hacer una venta manual y digitarla.
