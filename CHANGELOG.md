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

## 1.5.0 — 15 de septiembre de 2026

Los empaques dejan de ser un insumo más. Sin variables de entorno nuevas y sin
migración: los dos campos que se añaden a `products` nacen vacíos, y la bandera
nueva de la venta nace en `false`, que es exactamente el comportamiento de
antes.

> Se despliega **ANTES** que el frontend 1.5.0. El POS nuevo manda
> `packagingExplicit` y llama a `POST /sales/packaging-suggestion`, y el backend
> viejo —con `forbidNonWhitelisted`— rechazaría el cobro entero.

### Un empaque es un ítem de inventario marcado, no un tipo nuevo

`Product.isPackaging` marca las bolsas, los vasos y las cajas. Va como marca y
no como un cuarto `itemType` a propósito: un empaque se compra, entra por lotes,
se cuenta y se merma **igual** que un insumo, así que toda esa maquinaria ya
sirve tal cual. Un tipo nuevo habría obligado a cada sitio que mira el tipo
—importación por CSV, factura por foto, informes— a aprenderse un caso más sin
ganar nada a cambio.

Lo que sí cambia es que un empaque **no aparece en el POS aunque tenga precio**.
Es la única excepción a "lo decide el precio de venta, no el `itemType`": el
precio de una ficha de empaque es el de compra de un paquete de cien bolsas, y
verlo como un plato en la caja no le sirve a nadie. Si de verdad se vende la
bolsa suelta, se crea su producto a mano en el catálogo.

- `GET /inventory/products?isPackaging=true|false` filtra por la marca. Sin el
  parámetro devuelve todo junto, como siempre.
- `POST /inventory/products/adopt-packaging` marca de golpe los ítems que ya
  figuran como empaque en la ficha de algún vendible. Es idempotente y lo
  dispara una persona desde la pantalla: marcar fichas ajenas en un despliegue,
  en silencio, es justo lo que no se debe hacer.

### Foto en la ficha de inventario

`imageUrl` / `imagePathname` en `Product`, con `POST` y `DELETE` en
`/inventory/products/:id/image`. Mismo procedimiento que la foto del vendible y
el mismo orden, que es el que importa: primero se sube la nueva, luego se guarda
la ficha y solo al final se borra la anterior. Al eliminar un producto ahora se
borra también su archivo.

Las reglas de la imagen (4 MB, JPG/PNG/WebP/AVIF) se mudan de
`catalog/domain/product-image.ts` a `shared/storage/product-image.ts`: ya no son
solo del catálogo, y tenerlas duplicadas era garantizar que un día una pantalla
aceptara lo que la otra rechaza.

### El empaque que baja del inventario es el que se confirma al cobrar

Hasta ahora el empaque de la ficha del producto se descontaba siempre y lo que
se anotara en el cobro se **sumaba** encima. Eso hacía imposible decir "esta
venta sale sin empaque": una lista vacía no se distinguía de no haber opinado.

`packagingExplicit` invierte quién manda. Con la bandera, `packaging` es **todo**
el empaque de la venta —lista vacía incluida— y la ficha deja de descontar sola.
Sin la bandera no cambia nada, y eso es deliberado: el backend se despliega
primero, así que el POS anterior tiene que seguir cobrando exactamente igual que
ayer.

### La venta guarda con qué empaque salió

`Sale.packaging` y `Sale.packagingExplicit`. Antes esa información no existía en
ninguna parte: el empaque se fundía con la harina dentro de `components` y no
había forma de volver a separarlo.

Se guarda lo **pedido**, no lo que alcanzó a descontarse. Si las bolsas figuran
en cero porque nadie registró la compra, la venta salió en bolsa igual, y es eso
lo que hay que recordar. El costo sigue saliendo de `components`, así que no se
cuenta dos veces.

### Con qué empaque suele salir un carrito

`POST /sales/packaging-suggestion` responde con las líneas de empaque a proponer,
de dónde salieron (`historial` | `ficha` | `ninguno`) y cuántas ventas las
respaldan. La regla vive en `sales/domain/packaging-suggestion.ts`, sin Mongo y
con pruebas propias.

La regla es **una sola**: lo mismo que la vez anterior que se vendió este mismo
conjunto de productos; si no hay historial, lo que digan las fichas; y si
tampoco, nada. No extrapola cantidades a propósito — aprender "una galleta = una
bolsa" y proponer tres bolsas para tres galletas es peor que no proponer nada,
porque las tres galletas van en la misma bolsa y quien cobra tendría que
corregir a mano en cada venta.

Dos detalles que parecen menores y no lo son: el carrito se reconoce por el
**conjunto** de productos y no por las cantidades (si no, casi ninguna venta se
parecería a otra y la memoria no llegaría a servir nunca), y "esto se ha vendido
varias veces sin empaque" es una respuesta válida, no un hueco que se rellene
volviendo a proponer la bolsa de la ficha.

---

## 1.4.0 — 14 de septiembre de 2026

Sale del primer día de carga real de datos. Sin variables de entorno nuevas y
sin migración: el campo que se añade nace en `false`, que es justo el
comportamiento de antes.

> Se despliega **ANTES** que el frontend 1.4.0. La pantalla de roles nueva
> guarda permisos de Dueño y Administrador, y el backend viejo los rechaza.

### Todos los roles se pueden editar

Dueño y Administrador no se podían tocar. La razón era buena y sigue en pie: sus
permisos se leen de `SYSTEM_ROLES` (código) y no de la fila de `roles`, para que
una función nueva le llegue sola a todos los dueños al desplegar, sin correr una
semilla contra la base de cada empresa. El efecto colateral era que "Gerente" o
"Administrador" significaban lo que decidiera el sistema, y un rol que no se
puede ajustar convierte la pantalla de roles en un adorno.

Ahora esa resolución es **condicional**, con la bandera `permissionsCustomized`
en la fila del rol:

- Mientras está en `false`, manda el código y las capacidades nuevas llegan
  solas, exactamente como hasta ahora.
- En cuanto alguien guarda permisos pasa a `true` y manda la fila **para
  siempre**: `ensureSystemRoles` deja de pisarla, así que ni un despliegue ni
  una semilla deshacen el cambio en silencio.

El precio —que la interfaz dice antes de dejar editar— es que un rol tocado a
mano ya no recibe solo lo que se publique después.

### Lo único que se sigue prohibiendo: dejarse fuera a uno mismo

`update` rechaza quitar `roles.manage` o `users.manage` **del rol que tiene
puesto quien está editando**. Guardarlo cerraría esa pantalla para siempre y no
habría nadie que pudiera devolver el permiso, porque el único que podía era él:
la cuenta solo se rescataría metiendo mano en la base. Sobre cualquier otro rol
—incluido Dueño, si quien edita no es dueño— sí se puede, porque siempre
quedaría alguien capaz de deshacerlo.

7 pruebas nuevas (739 en total).

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
