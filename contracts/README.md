# Contratos de integración v1

Estos archivos son contratos, no implementaciones. La primera ruta es frontend → Gateway → Ventas → Inventario. Inventario es el único dueño del stock. Los identificadores y SKU son cadenas opacas, sensibles a mayúsculas y no vacías; no se normalizan. No se aceptan cadenas compuestas solo de espacios. No se fijan formato ni longitud adicionales en v1. Las cantidades son enteros de 32 bits con signo y deben ser mayores que cero; stock y umbral son enteros de 32 bits no negativos.

## Inventario gRPC

Definición: `proto/inventory/v1/inventory.proto`, paquete `smartstock.inventory.v1`.

- `GetProduct(sku)` devuelve `FOUND` y un `Product` con `sku`, `name`, `stock` y `threshold`; o `NOT_FOUND` / `INVALID_SKU` sin producto.
- `GetInventoryOverview()` devuelve el total de productos con stock en el umbral o por debajo y hasta cuatro productos cuyo stock es como máximo 1,5 veces el umbral. Los críticos aparecen primero.
- `DeductStock(sale_id, sku, quantity)` devuelve `DEDUCTED` y la instantánea del producto inmediatamente posterior al descuento, o `PRODUCT_NOT_FOUND`, `INSUFFICIENT_STOCK`, `INVALID_ARGUMENT` o `SALE_ID_CONFLICT`, sin producto. No puede dejar stock negativo.
- Para una solicitud válida, `sale_id` identifica globalmente la operación: Inventario conserva atómicamente sus argumentos y resultado definitivo, incluidos rechazos por producto inexistente o stock insuficiente. Repetir exactamente los mismos datos devuelve el resultado original, incluso si el stock cambió; no vuelve a descontar ni emite otro evento. Otra combinación de SKU o cantidad con el mismo `sale_id` devuelve `SALE_ID_CONFLICT`. Las solicitudes inválidas no reservan el identificador.
- Solicitudes concurrentes con el mismo identificador deben respetar estas reglas. El descuento, movimiento, resultado idempotente y, cuando corresponda, outbox se confirman en una misma transacción.
- Los resultados de negocio anteriores usan estado gRPC `OK` y el campo `result`; un estado gRPC distinto de `OK` indica fallo técnico o de transporte, no rechazo de negocio. Si se pierde la respuesta, el llamador reintenta exactamente la misma solicitud: el resultado puede ser incierto.

## Ventas gRPC

Definición: `proto/sales/v1/sales.proto`, paquete `smartstock.sales.v1`.

- `CreateSale(sale_id, sku, quantity)` devuelve `ACCEPTED` y una venta en `PENDING`, `CONFIRMED` o `REJECTED`; o `INVALID_ARGUMENT` / `SALE_ID_CONFLICT` sin venta. `ACCEPTED` también cubre una repetición idéntica y no implica confirmación.
- El cliente genera y conserva un `sale_id` globalmente único y estable. Repetirlo con idénticos SKU y cantidad devuelve la misma venta en su estado actual; usarlo con otros datos es conflicto, incluso después de un rechazo. Las solicitudes inválidas no reservan el identificador.
- `GetSale(sale_id)` devuelve `FOUND` y la venta, `NOT_FOUND` o `INVALID_SALE_ID`. `REJECTED` lleva `PRODUCT_NOT_FOUND` o `INSUFFICIENT_STOCK`; los demás estados llevan `REJECTION_REASON_UNSPECIFIED`. Un resultado desconocido o no especificado no debe interpretarse como éxito.
- `GetSalesOverview()` suma las unidades de ventas confirmadas registradas durante el día de operación en `America/Santiago` y devuelve hasta cinco ventas confirmadas recientes, con fecha de registro UTC.
- Ventas solo marca `CONFIRMED` después de que Inventario confirme `DEDUCTED`. Un rechazo definitivo de Inventario produce `REJECTED`; un timeout, desconexión o fallo técnico no es un rechazo. Ventas debe conservar `PENDING` y reconciliar reintentando Inventario con el mismo identificador y argumentos hasta conocer el resultado; no puede iniciar otro descuento con un ID nuevo.
- Los resultados de negocio usan gRPC `OK`; un estado distinto de `OK` es técnico o de transporte y puede dejar el resultado incierto. Si se pierde la respuesta, consultar o reintentar con el mismo `sale_id`. Un `NOT_FOUND` tras una respuesta perdida no demuestra que una solicitud concurrente no vaya a completarse: reintentar con los mismos datos.

## Gateway GraphQL

Definición SDL: `graphql/schema.graphql`. El Gateway mapeará los contratos anteriores; no está implementado aquí.

- `product(sku)` y `sale(id)` devuelven el objeto o `null` si no existe. Entradas inválidas o fallos técnicos producen `errors` de GraphQL con códigos `INVALID_ARGUMENT` o `UPSTREAM_UNAVAILABLE` en `extensions.code`, respectivamente; no se confunden con ausencia. El campo afectado es `null`.
- `inventoryOverview`, `salesOverview` y `purchasesOverview` se consultan independientemente. Un fallo técnico deja el campo afectado en `null` con `UPSTREAM_UNAVAILABLE`. Una lectura exitosa sin registros devuelve conteos en cero y listas vacías.
- `createSale(input: {saleId, sku, quantity})` devuelve `ACCEPTED` con `sale` no nula para cualquier estado de la venta, `INVALID_ARGUMENT` o `SALE_ID_CONFLICT` sin venta, o `UNKNOWN` sin venta si el Gateway no puede determinar el resultado. `UNKNOWN` no significa rechazo. Si falla la propia respuesta GraphQL o la conexión, el resultado también es incierto.
- El frontend crea y guarda `saleId`, SKU y cantidad antes de enviar; ante `UNKNOWN`, errores o desconexión consulta `sale(id)` y/o reintenta `createSale` con los mismos datos. `PENDING` requiere consultas posteriores; `NOT_FOUND` se representa por `sale: null` y no impide reintentar. Un cambio de datos requiere una operación nueva con otro ID.
- `rejectionReason` solo está presente para `REJECTED`; sus valores tienen el mismo significado que en gRPC. `Int` es de 32 bits. Aunque GraphQL acepta números como `ID`, los clientes deben enviar `saleId` e `id` como cadenas para preservar el identificador exacto.

## Evento Kafka `inventory.stock_low.v1`

Esquema JSON Schema draft 2020-12: `events/inventory.stock_low.v1/schema.json`; ejemplo: `example.json` en ese directorio. El nombre `inventory.stock_low.v1` identifica el contrato y es también el nombre del topic inicial. El payload usa `event_type: "inventory.stock_low"` y `event_version: 1`; `occurred_at` es fecha-hora UTC RFC 3339 terminada en `Z`. `event_id` es único y estable al reenviar; `sale_id` identifica la venta causante.

Se genera solo cuando `previous_stock > threshold` y `current_stock <= threshold`: 10 → 7 con umbral 7 sí genera alerta. El esquema valida la forma y los rangos, pero la comparación entre campos es una regla semántica que el productor debe verificar. La clave Kafka será el SKU codificado en UTF-8.

Inventario guarda el evento en un outbox en la misma transacción que el descuento y el movimiento. El publicador puede entregar el evento más de una vez; Compras debe deduplicar por `event_id` de forma transaccional con la persistencia de la necesidad de reposición. No se garantiza entrega exactamente una vez. Este contrato no implementa el comportamiento de Compras.

## Contrato v1: Gateway–Compras por Kafka

Esta sección y los esquemas `events/purchases.requests.v1/` y
`events/purchases.results.v1/` definen el contrato autorizado por el responsable
del proyecto para Gateway y Compras. No describen capacidades ya implementadas,
no modifican el GraphQL existente y no autorizan acceso a la base de Compras.
Se definen dos topics con esos mismos nombres: Gateway
publica solicitudes y Compras publica resultados. Cada mensaje es JSON UTF-8;
la clave Kafka es `request_id` codificado en UTF-8. Los esquemas son la
referencia para los campos obligatorios, tipos y valores; rechazan campos
adicionales. Las cadenas identificadoras son opacas, sensibles a mayúsculas y
no vacías ni compuestas solo por espacios, sin normalización. Las fechas son
RFC 3339 UTC terminadas en `Z`.

### Operaciones

| `type` | Solicitud | Resultado `OK` |
|---|---|---|
| `get_need` | `event_id` de una alerta | Necesidad registrada para ese evento. |
| `list_needs` | `sku`, `limit`, `cursor` | Página de necesidades del SKU. |
| `list_offers` | `sku`, `limit`, `cursor` | Página de ofertas del SKU. |
| `get_order` | `order_id` | Estado y términos de la orden. |
| `create_draft` | `order_id`, `need_event_id`, `offer_id`, `quantity` | Orden en `DRAFT`. |
| `decide_order` | `order_id`, `expected_revision`, `decision`, `actor_id` | Orden `APPROVED` o `REJECTED`. |
| `get_overview` | Objeto vacío | Total de necesidades registradas, total de órdenes `DRAFT` o `APPROVED` y hasta cinco necesidades recientes. |

En el resumen, una necesidad figura como `APPROVED` si tiene una orden aprobada, como
`DRAFT` si tiene un borrador y como `PENDING` en los demás casos. Compras aún no registra
recepciones. Actualiza Gateway y Compras antes de enviar `get_overview`, ya que los
consumidores anteriores rechazan tipos de operación desconocidos.

Para las listas, `cursor: null` inicia la consulta, `limit` está entre 1 y
100 y `next_cursor: null` indica fin. Un cursor no nulo es opaco, pertenece a
la operación y SKU originales y no debe modificarse; uno inválido o expirado
produce `INVALID_ARGUMENT`. Cada página es una lectura actual: no se garantiza
una instantánea entre páginas y pueden aparecer cambios concurrentes. El cliente
debe deduplicar por `event_id` u `offer_id` y reiniciar si necesita información
actualizada. El orden es estable por identificador ascendente para datos sin
cambios; una respuesta tiene como máximo el `limit` solicitado.

La necesidad representa la alerta persistida, no el stock actual. Una oferta
contiene proveedor, SKU, precio unitario decimal como cadena no negativa, código
de moneda de tres letras mayúsculas, cantidad mínima y plazo entero en días. El
precio evita conversiones de punto flotante; la validez del código de moneda y
las condiciones comerciales requieren validación de Compras. La oferta incluida
en una orden es la instantánea aceptada al crearla, no una consulta dinámica.
Compras valida que necesidad y oferta existan y compartan SKU, que la oferta sea
aplicable y que la cantidad cumpla su mínimo; un borrador no aprueba ni compra.
Las reglas comerciales adicionales deberán acordarse antes de implementar.

`order_id` lo genera Gateway y es único y estable. No se permite reutilizarlo
para otra orden. Una orden empieza en `DRAFT`, revisión 1; solo una decisión
humana autorizada puede cambiarla a `APPROVED` o `REJECTED`. La decisión es
atómica y exige que la revisión coincida; al aplicarse incrementa la revisión
en uno y registra `decided_by`. Una decisión concurrente o sobre una orden ya
decidida devuelve `CONFLICT`, sin cambiarla. Una repetición de la misma
solicitud se trata según las reglas de idempotencia, no como una nueva
decisión. `actor_id` identifica al operador autenticado; no es una prueba de
identidad por sí mismo.

### Resultados, recuperación y seguridad

- `OK` lleva datos con la forma correspondiente a la operación. `NOT_FOUND`,
  `INVALID_ARGUMENT`, `CONFLICT` y `FORBIDDEN` son resultados definitivos con
  `data: null`. `NOT_FOUND` indica ausencia al procesar esa solicitud, no
  garantiza que un evento o comando concurrente no se aplique después.
- Gateway genera un `request_id` globalmente único para cada operación y guarda
  la solicitud completa antes de publicarla. Una repetición usa exactamente
  el mismo mensaje, incluido `occurred_at`. Compras conserva el resultado de
  cada solicitud, incluso las consultas y rechazos, y lo vuelve a publicar ante
  una repetición idéntica. Para una lectura actualizada se genera otro ID.
- La deduplicación, el cambio de negocio cuando exista y el resultado/outbox
  se confirman atómicamente en Compras antes de confirmar el offset. Gateway
  persiste y deduplica resultados antes de confirmar sus offsets. La entrega es
  al menos una vez; una publicación o confirmación Kafka no demuestra que
  Compras haya aplicado la operación. Las implementaciones deben conservar los
  registros de idempotencia durante toda la vida operativa de v1; cualquier
  política de expiración requiere un contrato posterior.
- Si se reutiliza un `request_id` con otro contenido, Gateway debe impedir su
  publicación. Compras no ejecuta la segunda solicitud ni sustituye el resultado
  original: registra el incidente y detiene su procesamiento para intervención
  operativa, sin emitir un resultado ambiguo con el mismo ID. Los mensajes
  malformados también requieren intervención sin avanzar el offset.
- Ante timeout, pérdida de respuesta o reinicio el resultado es **desconocido**,
  no un rechazo. Gateway conserva el estado pendiente y puede reenviar el
  mensaje idéntico; correlaciona por `request_id` y `type`. Puede consultar
  una orden con otro ID, pero la ausencia no demuestra que un comando
  concurrente no vaya a completarse. No debe crear un nuevo ID de operación
  para repetir una decisión o creación incierta.
- Kafka y el transporte deben autenticar servicios y limitar publicación y
  consumo mediante ACL. Gateway autentica y autoriza al operador antes de
  aceptar una decisión y transmite su identidad; Compras solo acepta decisiones
  del Gateway autorizado y valida la autorización mediante un mecanismo
  confiable acordado entre ambos. Un agente MCP nunca puede aprobar ni rechazar.
  El formato de credenciales y la propagación verificable de identidad aún
  requieren acuerdo; hasta entonces no debe habilitarse este flujo en producción.

## Distribución entre repositorios

Usar este repositorio como **submódulo Git fijado a un commit completo** en `vendor/smartstock-infra` de cada repositorio consumidor. Tras acordar y confirmar los contratos en un commit de este repositorio, el coordinador debe comunicar su SHA completo; una copia sin commit o una rama móvil no identifica una revisión reproducible.

En cada consumidor, con una URL accesible del repositorio de infraestructura:

```sh
git submodule add <URL-smartstock-infra> vendor/smartstock-infra
git -C vendor/smartstock-infra checkout --detach <SHA-completo-contratos>
git add .gitmodules vendor/smartstock-infra
```

La revisión del consumidor debe registrar tanto `.gitmodules` como el gitlink. En local y CI, clonar con `git clone --recurse-submodules <URL-consumidor>` o ejecutar `git submodule update --init --recursive`; comprobar `git -C vendor/smartstock-infra rev-parse HEAD` frente al SHA acordado. La URL y credenciales de lectura necesarias en CI deben coordinarse; no se asume que el commit local esté disponible remotamente hasta que se distribuya por un canal autorizado.

Generar las clases para cada lenguaje desde `vendor/smartstock-infra/contracts/proto` usando las herramientas y plugins fijados por cada consumidor. `go_package` es una ruta lógica para código generado: cada consumidor Go debe configurar su generación/dependencias para que esa ruta resuelva; no implica que exista un módulo Go publicado. El consumidor GraphQL usa el SDL como contrato y Compras el esquema de evento. Para Docker, inicializar el submódulo **antes** de `docker build`, incluirlo en el contexto del propio consumidor y no excluirlo en `.dockerignore`; el Dockerfile puede copiar `vendor/smartstock-infra/contracts/`. Un contexto que apunte a un subdirectorio debe ampliarse o recibir una copia explícita dentro de él. No se leen carpetas hermanas desde el build.

## Validación local

Con Node.js y npm, instalar las herramientas en un directorio temporal fuera del repositorio:

```sh
TOOLS_DIR="$(mktemp -d)"
npm install --prefix "$TOOLS_DIR" grpc-tools@1.13.0 ajv@8.20.0 ajv-formats@3.0.1 graphql@16.15.0
"$TOOLS_DIR/node_modules/.bin/grpc_tools_node_protoc" -Icontracts/proto \
  --descriptor_set_out="$TOOLS_DIR/smartstock-contracts.pb" \
  contracts/proto/inventory/v1/inventory.proto contracts/proto/sales/v1/sales.proto
NODE_PATH="$TOOLS_DIR/node_modules" node contracts/validate.cjs
```

El compilador verifica las definiciones Protobuf. El script valida el SDL, el esquema JSON y su ejemplo, incluyendo la regla semántica de cruce y algunos casos inválidos. No prueba servidores, generación de clientes por lenguaje ni integración entre repositorios.
