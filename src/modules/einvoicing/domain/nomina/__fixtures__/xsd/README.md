# XSD oficiales de la nómina electrónica (anexo técnico V1.0, Res. DIAN 000013/2021)

Copiados de la caja de herramientas oficial de nómina, **sin tocar su contenido**:

- Fuente: <https://www.dian.gov.co/impuestos/factura-electronica/Documents/Caja-de-Herramientas-Nomina-Electronica-V1-0.zip>
  (enlazada desde la página DIAN del Documento Soporte de Pago de Nómina Electrónica), descargada el 2026-10-11.
  SHA-256 del zip: `0b2d0f8405d144989e5e36bdb50bb04a57c564dc1217971f43f98861c50a5ee3`.
- `NominaIndividualElectronicaXSDV1.0.6.xsd` (102) y `NominaIndividualDeAjusteElectronicaXSDV1.0.6.xsd` (103), de la
  carpeta `XSD/` de la caja. Importan `../common/UBL-CommonExtensionComponents-2.1.xsd`: la carpeta `Schemes/` de la caja
  de nómina es idéntica, byte a byte, a `../common/` (comparado archivo por archivo), así que no se duplica: el validador precarga `ubl/__fixtures__/xsd/common`.
- `ejemplos/` son los dos ejemplos oficiales de `Ejemplificaciones/` (versión 1.0.2, 2024-02-22). Traen valores de
  relleno («A», «0», «9999-12-31») y el `ext:UBLExtensions` vacío.

La caja trae los XSD con fin de línea CRLF; el repo guarda todo en LF (`.gitattributes`), así que se copiaron con
`tr -d '\r'` y nada más. Por eso hay dos huellas por XSD.

## SHA-256

```
# Tal como vienen en la caja (CRLF)
b1a7f6f321d8a0aa906f192ca2175fb72ba9e4d6d7968dc0d0d9b9cc9fd92f06  NominaIndividualElectronicaXSDV1.0.6.xsd
829a412d5e8670a98fef1673e1039638a8871d4d3920d76f9b3f71da2d28fda0  NominaIndividualDeAjusteElectronicaXSDV1.0.6.xsd

# Como quedan en el repo (LF)
453a49f2dc32f6b6cdbae368caac35ea35681df7a97e9cbf1c6f6de6e031aa52  NominaIndividualElectronicaXSDV1.0.6.xsd
65f8a2040ecb91146a61331e3ff81b679248263c7acc6e30a5cedf63b74f539b  NominaIndividualDeAjusteElectronicaXSDV1.0.6.xsd
9739babccd11925d0cc54344e48a9e1f04f08ce75381fe50232acf92a9139563  ejemplos/nomina-individual-v1.0.2.xml
54eda197e165340752ed9205a18b05ca10403def64c6245bb1e97ea5ad65880c  ejemplos/nomina-individual-ajuste-v1.0.2.xml
```

## Qué valida y qué no

- **Sí**: la estructura del documento (orden de los elementos, atributos obligatorios, tipos `xsd:integer`, `decimal`,
  `date`, `time`). El validador es `../validar-xsd-nomina.test.ts` (ignora solo el error del slot de firma vacío) (devDependency `xmllint-wasm`, sin red).
- **No**: el contenido `lax` de `ext:ExtensionContent` (la firma; se verifica criptográficamente en los tests) ni las
  reglas NIE/NIAE del anexo (CUNE, cuadre de totales, catálogos). Esas las prueban los tests de `domain/nomina/xml-nomina.spec.ts`. El
  validador definitivo es la DIAN (set de pruebas de nómina).
