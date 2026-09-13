# Historial de versiones — BookiPos (backend)

Qué cambió en cada versión y cuándo. Lo mismo del lado del frontend está en el
`CHANGELOG.md` de `Front_Booki`: los dos repos comparten número de versión
porque se despliegan juntos y se usan juntos.

## Cómo se numera

`MAYOR.MENOR.PARCHE` — por ejemplo `1.1.0`.

| Cuál sube | Cuándo | Ejemplo |
|---|---|---|
| **Parche** (1.1.**0** → 1.1.**1**) | Se arregló algo que estaba mal, sin funciones nuevas | El total de una cuenta salía mal |
| **Menor** (1.**1**.0 → 1.**2**.0) | Funciones nuevas, sin romper lo que ya había | Esta entrega |
| **Mayor** (**1**.1.0 → **2**.0.0) | Algo dejó de funcionar como antes y hay que hacer algo para adaptarse | Cambiar cómo se guardan los precios y tener que migrar datos |

**Cuándo se sube el número:** al mezclar a `main` un grupo de cambios que ya es
una entrega — no en cada PR. Un PR suelto no cambia la versión; lo que la cambia
es decidir "esto ya es lo que va a usar el negocio".

---

## 1.2.0 — 12 de septiembre de 2026

Empaque y vendedor en la venta. Sin variables de entorno nuevas, sin
migraciones y sin permisos nuevos: los campos nuevos nacen vacíos y las ventas
que no los mandan quedan exactamente como antes.

> **Este backend se despliega ANTES que el frontend 1.2.0.** El frontend nuevo
> manda `seller` y `packaging`; con `forbidNonWhitelisted`, el backend viejo
> rechazaría el cobro entero. Al revés no hay problema: el frontend viejo no
> manda los campos nuevos.

### Ventas

- **Empaque que se descuenta solo.** `CatalogProduct.packaging` (misma forma
  que `recipe`) dice qué gasta cada unidad vendida, tenga el producto receta o
  no. Además, `CreateSaleDto.packaging` y `CheckoutOrderDto.packaging` llevan
  el empaque extra anotado al cobrar. Todo entra al mismo `stock.sell`, así que
  su costo suma al COGS de la venta.
  - **Nunca tumba un cobro.** Se suma después del pre-chequeo de existencias y
    se acota a lo que haya: sin bolsas registradas, la venta pasa y el
    inventario queda en cero, no en negativo. La mercancía sí bloquea.
  - **La devolución parcial no lo devuelve** —la bolsa ya se usó—, porque arma
    lo que vuelve con `componentsOf`, que no incluye empaque. La anulación sí
    lo devuelve: revierte `components` completo, como si la venta no hubiera
    existido.
  - `CatalogService.packagingOf` va aparte de `componentsOf` a propósito.
- **Vendedor.** `Sale.seller` (`{ employeeId?, name }`), opcional en la venta
  directa y en el cobro de una cuenta. Se copia el nombre porque el empleado
  puede irse o cambiar en la ficha. Sin vendedor, la venta queda a nombre de
  `cashierName`, como siempre.

732 pruebas pasan (13 nuevas: `sales.service.empaque.spec.ts` y
`sales.service.seller.spec.ts`).

---

## 1.1.0 — 12 de septiembre de 2026

Los siete huecos de producto de la hoja de ruta, más tres pendientes que
quedaban apuntados. Veinte pull requests.

**Nada de esto requirió tocar Vercel ni Atlas**: sin variables de entorno
nuevas, sin migraciones y sin permisos nuevos. Todos los campos nuevos nacen
vacíos o en cero, así que las empresas que ya estaban operando no cambiaron de
comportamiento por su cuenta.

### Inventario

- **Unidad de compra distinta a la de consumo.** `Product` guarda
  `purchaseUnit` + `purchaseFactor` ("bulto", 25000). El costo se sigue
  almacenando por unidad de consumo, que es de lo que viven recetas, kárdex,
  FEFO y márgenes. La entrada de mercancía acepta `inPurchaseUnits` y convierte
  en el servidor. (#22)
- **Conteo físico masivo.** `POST /inventory/stock/count` deja las existencias
  en lo contado. No suma: por eso no se podía resolver con `stock/import`, que
  registra cada fila como entrada. (#23)
- **Trazabilidad hacia adelante.** `GET /reports/trazabilidad/lotes/:id` sigue
  la cadena de un lote hasta los clientes, pasando por las órdenes de
  producción. (#26)
- **Reporte de merma.** `GET /inventory/waste-report` agrupa las bajas por
  producto y por razón, con su costo. Un ajuste por conteo no cuenta como
  merma. (#30)

### Ventas

- **Listas de precios.** Porcentaje general más precios pactados por producto,
  con cantidad mínima opcional (precio por cantidad). Se asignan al cliente y se
  aplican solas; elegir una a mano pide `pos.discount.authorize`. (#24)
- **Devolución parcial.** `POST /sales/:id/returns` con motivo, destino
  (inventario o merma) y forma de reembolso. El registro se crea antes de mover
  stock y plata. (#25)
- **Dividir la cuenta.** Cada cobro paga un subconjunto de la comanda; la cuenta
  sigue abierta hasta que no quede nada. Bloqueo optimista con `paymentSeq`
  contra dos cobros simultáneos. (#27)

### Domicilios

- **Zonas con tarifa fija por sede**, más valor a mano para el pedido que no cae
  en ninguna. Nada de cálculo por kilómetros. El cobro del domicilio no lleva
  IVA y va encima del total, como la propina, pero sí es ingreso del negocio y
  por eso sí va al libro contable. (#28)
- **Seguimiento de la entrega y cuadre por repartidor.** Estados con hora de
  salida y de llegada; el cuadre cuenta solo el efectivo de lo entregado. (#31)

### Compras

- **Comprar y facturar en la presentación del proveedor.** Un renglón de orden
  de compra puede venir en bultos; el inventario convierte al recibir. En la
  factura por foto la marca se propone cuando el producto tiene presentación.
  (#29)

---

## 1.0.0 — antes del 12 de septiembre de 2026

Lo que ya estaba funcionando en producción: POS, inventario con lotes y FEFO,
producción, compras con lectura de factura por foto, caja, nómina, facturación
electrónica DIAN, multiempresa y cobro por suscripción.

No hay historial detallado de esta versión: el número se empezó a llevar a
partir de la 1.1.0, y se le puso 1.0.0 a lo que ya estaba en uso.
