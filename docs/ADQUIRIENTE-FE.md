# Adquiriente de la factura electrónica

Fuente: Anexo técnico de la factura electrónica de venta v1.9 (DIAN), tablas de tipos de
documento, tipo de persona y responsabilidades fiscales. El catálogo se transcribió del
anexo y no se contrastó en línea; revísalo contra la versión vigente antes de habilitar.

## Qué se captura en el cliente (todo opcional)

`dianDocType` (11, 12, 13, 21, 22, 31, 41, 42, 43, 47, 48, 50, 91), `nitDv` (solo NIT),
`tipoPersona` (1 jurídica, 2 natural), `responsabilidadesFiscales` (O-13, O-15, O-23,
O-47, R-99-PN), `regimen`, `municipioDane` (5 dígitos), `emailFacturacion`. La dirección
es la `address` que ya existía. El `docType` histórico (CC/NIT/CE/PAS) no se toca.

Al crear o editar un cliente con NIT, el DV se valida con el módulo 11 de la DIAN
(`calcularDvNit`, pesos 3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71). Si no
cuadra, 400 con el campo a corregir. Editar solo valida si se tocó el tipo o el DV, para
no bloquear a un cliente viejo.

## Cómo queda `buildAdquiriente` (`einvoicing/domain/adquiriente.ts`)

- La venta congela los datos fiscales de la ficha (`sale.customer`) cuando se vende a un
  cliente registrado y el documento tecleado es el de la ficha.
- Sin cliente, sin número o **sin tipo de documento DIAN**: consumidor final
  `222222222222`, tipo 13, R-99-PN. Un número suelto no se adivina por su largo.
- Con tipo y número: sale con ese tipo. En NIT, el número va sin DV y el DV aparte.
- `validarAdquirienteParaFactura(cliente)` devuelve `{ esConsumidorFinal, faltantes }`
  para una FEV con datos; la emisión de la FEV la usará para rechazar antes de firmar.

## Clientes existentes

`node dist/datos/2026-10-tipo-documento-dian-clientes.js --empresa <id> [--aplicar]`
propone `dianDocType` 31 y `nitDv` solo para `docType` NIT con guion y DV válido. El resto
se cuenta como ambiguo y no se toca. Mientras no tengan tipo, saldrán como consumidor final.
