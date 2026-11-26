# Entorno local de integración

Este entorno es solo para desarrollo local: las credenciales son de prueba, gRPC y Kafka no usan TLS ni autenticación. Las rutas internas de Compras del Gateway requieren un token local compartido, no identidad de operador de producción. No exponerlo en una red pública. Cada microservicio usa únicamente su propia base PostgreSQL.

## Preparación

Se requieren Docker, Docker Compose y acceso a las imágenes y dependencias de build. Los ejemplos de consola también usan `curl`, `jq` y `uuidgen`. Los cinco repositorios deben estar como carpetas hermanas de `smartstock-infra`, con sus implementaciones presentes y los submódulos inicializados. En cada uno comprobar, sin modificar su código:

```sh
git -C ../smartstock-inventario submodule status
git -C ../smartstock-ventas submodule status
git -C ../smartstock-gateway submodule status
git -C ../smartstock-front submodule status
git -C ../smartstock-compras submodule status
```

El primer carácter `-` indica que falta inicializarlo; desde el repositorio correspondiente, su propietario puede ejecutar `git submodule update --init --recursive`. Gateway y Compras usan `c5867a8d48383dcadae2111eb2bf20770645e565`, que agrega los contratos Kafka de Compras sin cambiar GraphQL ni Protobuf. Los demás consumidores mantienen la revisión compatible `6237ae7a047c3a16077db5bdd51a6ee89f5f90f1`. La revisión nueva está distribuida localmente; antes de clonar desde remoto, confirmar que esté publicada por un canal autorizado. Los builds reciben como contexto el directorio de cada aplicación, no una carpeta hermana desde dentro de su Dockerfile.

Desde `smartstock-infra`, elegir un nombre de proyecto nuevo y libre y comprobar que no existan volúmenes con ese prefijo:

```sh
export COMPOSE_PROJECT_NAME=smartstock-demo-20261124
docker volume ls --filter "name=${COMPOSE_PROJECT_NAME}_"
docker compose config --quiet
docker compose up --build -d --wait --wait-timeout 240
docker compose ps -a
```

Si el nombre ya tiene volúmenes, usar otro: reutilizarlos conserva datos previos. Compose crea volúmenes independientes para las cuatro bases y Kafka; no publica sus puertos al host. Para parar sin borrar datos, ejecutar `docker compose stop`. No usar `down -v` ni eliminar volúmenes existentes sin autorización. Para repetir la demo desde cero, elegir otro nombre de proyecto y, si el anterior sigue activo, otros puertos: `export DEMO_HTTP_PORT=8081` y `export GATEWAY_HTTP_PORT=3002`. El seed de Inventario solo inserta `SKU-001` si no existe: reiniciar no restablece su stock.

Acceso local: **http://localhost:8080/** y **http://localhost:8080/graphql** (o el puerto `DEMO_HTTP_PORT`). El frontend se construye con `/graphql`; Nginx dirige esa ruta al Gateway y las demás al frontend. Las solicitudes del navegador permanecen en el mismo origen, sin exigir CORS. El puerto está enlazado solo a `127.0.0.1`.

Nginx actualiza las direcciones de Gateway y del frontend mediante el DNS
interno de Docker. Si se reemplaza alguno de esos contenedores, el proxy
vuelve a conectarse cuando el servicio esté listo y se actualice la resolución.
La configuración de `web` requiere Nginx 1.27.3 o posterior.

Los topics `inventory.stock_low.v1`, `purchases.requests.v1` y `purchases.results.v1` se crean antes de iniciar Inventario, Gateway y Compras. Kafka anuncia `kafka:9092` para los contenedores. Inventario espera su PostgreSQL y los topics; Ventas espera su PostgreSQL e inicia con destino `inventory:50051`. El Gateway usa `sales:9090`, no su valor predeterminado `50052`. `service_started` no garantiza que gRPC esté listo: esperar a que el producto se pueda consultar. Cada servicio aplica su propio esquema al iniciar.

## Gateway ↔ Compras: solicitudes reales

Gateway usa una base propia `gateway-db` y publica su puerto solo en loopback:
`http://127.0.0.1:3001` (configurable con `GATEWAY_HTTP_PORT`). El token de
demostración es `smartstock-local-development-only`, reemplazable mediante
`PURCHASES_INTERNAL_TOKEN`. No exponer estas credenciales o Kafka a redes públicas.
El proxy web sigue enviando únicamente GraphQL al Gateway, no las rutas internas.

```sh
curl http://127.0.0.1:3001/internal/purchases/requests \
  -H 'Authorization: Bearer smartstock-local-development-only' \
  -H 'Idempotency-Key: offers-001' \
  -H 'Content-Type: application/json' \
  -d '{"type":"list_offers","payload":{"sku":"SKU-001","limit":10,"cursor":null}}'
```

Guardar el `request_id` y consultar
`GET /internal/purchases/requests/<request_id>` con el mismo token hasta
`COMPLETED`. El `outcome` pertenece a Compras; `PENDING` no demuestra rechazo.
Repetir el POST con la misma clave recupera la solicitud original; usar otra
clave para lecturas nuevas. Un reintento pendiente también puede solicitarse
mediante `POST /internal/purchases/requests/<request_id>/retry`.

### Prueba reproducible de las seis operaciones

Elegir un proyecto y puertos libres. Este ejemplo crea datos de prueba, registra
ventas y decisiones, detiene/reinicia **solo** Gateway y Compras de ese proyecto
y conserva sus volúmenes. La prueba necesita stock inicial 10; no reutilizar
volúmenes de otra ejecución.

```sh
export COMPOSE_PROJECT_NAME=smartstock-purchases-mi-prueba
export DEMO_HTTP_PORT=8082
export GATEWAY_HTTP_PORT=3002
export PURCHASES_ALLOW_LOCAL_DECISIONS=true
docker compose config --quiet
docker compose up --build -d --wait --wait-timeout 240
SMOKE_ALLOW_RESTARTS=true node compose/purchases-smoke.cjs
```

La prueba recorre una venta real → descuento 10 a 7 → evento de Inventario →
necesidad en Compras; luego consulta necesidades/ofertas, crea y consulta
borradores, aprueba y rechaza, comprueba conflictos/idempotencia y recupera
solicitudes tras reiniciar servicios. Las consultas y mutaciones GraphQL pasan
por Nginx, y la consulta de producto debe volver a responder con stock 7
después de reiniciar Gateway, sin reiniciar el proxy. Las rutas internas
se siguen comprobando en el puerto directo de Gateway. La prueba toma los
puertos de `DEMO_HTTP_PORT` y `GATEWAY_HTTP_PORT`; se pueden indicar también
`WEB_URL` y `GATEWAY_URL` como orígenes loopback distintos.

Sin `SMOKE_ALLOW_RESTARTS=true` no detiene
contenedores; sin `PURCHASES_ALLOW_LOCAL_DECISIONS=true` comprueba que las
decisiones se rechacen con 403.

Opcionalmente añadir `SMOKE_TRANSPORT_FAILURES=true` junto con
`SMOKE_ALLOW_RESTARTS=true` para detener temporalmente la base del Gateway y
Kafka durante 40 segundos cada uno y comprobar recuperación automática sin
reiniciar las aplicaciones. Solo usarlo en el proyecto aislado de la prueba.

Las decisiones están deshabilitadas por defecto en Compose. La autorización
de demostración exige además `PURCHASES_ENVIRONMENT=local` y
`actor_id: "local-operator"` en ambos extremos. No es seguridad de producción.
Para deshabilitarlas después de probar, quitar la variable y recrear Gateway
y Compras; conservar las bases y los registros de idempotencia.

### Verificación local realizada el 25 de noviembre de 2026

La prueba completa terminó con `PASS` en el proyecto
`smartstock-purchases-20261125`, Gateway `http://127.0.0.1:3002` y web
`http://127.0.0.1:8082`. Incluyó las seis operaciones, decisiones locales,
reintentos, reinicios y ambas interrupciones de 40 segundos. Las dos colas
terminaron con lag 0 y Gateway sin solicitudes pendientes.

La solicitud de borrador `5271f913-a4a6-4013-9431-4c46ebb8373c` conservó en ambos
registros su respuesta original `DRAFT`, mientras la orden
`4642016c-59cd-49e9-ae60-bc19b050e302` quedó `APPROVED`, revisión 2.
Esos identificadores son evidencia de esa ejecución, no datos fijos para repetir
la demostración.

Pasaron además 18 pruebas de Gateway (incluido PostgreSQL real en una base de
prueba separada) y 61 de Compras con PostgreSQL/Kafka reales. En Compras la
cobertura fue 85,71 % de líneas y 80,08 % de ramas. El SDK ARM64 presentó
intermitentemente SIGILL durante intentos previos; la ejecución final de pruebas
usó `DOTNET_EnableHWIntrinsic=0` y `-p:UseSharedCompilation=false`. Las imágenes
de ejecución se construyeron y pasaron la demostración sin ese ajuste.

## Demostración mediante GraphQL

Usar un proyecto y volúmenes nuevos. Consultar primero y continuar solo si stock = 10 y umbral = 7:

```sh
GRAPHQL_URL="http://localhost:${DEMO_HTTP_PORT:-8080}/graphql"
curl -sS "$GRAPHQL_URL" -H 'content-type: application/json' \
  -d '{"query":"query { product(sku:\"SKU-001\") { sku name stock threshold } }"}'
```

Generar un identificador único, guardarlo y enviar la venta:

```sh
SALE_ID="demo-$(uuidgen)"
echo "$SALE_ID"
curl -sS "$GRAPHQL_URL" -H 'content-type: application/json' \
  --data-binary "$(jq -nc --arg id "$SALE_ID" \
    '{query:"mutation($input: CreateSaleInput!) { createSale(input: $input) { outcome sale { saleId sku quantity status rejectionReason } } }",variables:{input:{saleId:$id,sku:"SKU-001",quantity:3}}}')"
```

Consultar el estado hasta `CONFIRMED` o `REJECTED`; `PENDING`, `UNKNOWN` y fallos de red no son rechazo. Para reintentar, repetir la mutación anterior **con el mismo** `SALE_ID` y argumentos.

```sh
curl -sS "$GRAPHQL_URL" -H 'content-type: application/json' \
  --data-binary "$(jq -nc --arg id "$SALE_ID" \
    '{query:"query($id: ID!) { sale(id: $id) { saleId sku quantity status rejectionReason } }",variables:{id:$id}}')"
```

Tras una confirmación, volver a consultar el producto: debe quedar en 7, también después del reintento. Los comandos `curl` no demuestran por sí solos el flujo del navegador.

## Inspección de Compras

En un proyecto nuevo, obtener el evento emitido desde el topic (el consumidor termina tras el primer mensaje):

```sh
docker compose exec -T kafka /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server kafka:9092 --topic inventory.stock_low.v1 \
  --from-beginning --max-messages 1 --timeout-ms 10000
```

Comprobar su `sale_id` y tomar su `event_id`. Inspeccionar la necesidad mediante el comando del propio servicio de Compras:

```sh
docker compose run --rm --no-deps compras --inspect <event_id>
```

La inspección puede necesitar un nuevo intento si el consumidor aún no procesó el evento. `docker compose logs compras inventory kafka-init` ayuda a diagnosticar fallos. La inspección operativa no es una interfaz entre microservicios. Una reentrega controlada modifica el topic: realizarla solo en un proyecto desechable y conservar el mismo payload, `event_id` y clave Kafka igual al SKU.

En la imagen actual de Compras puede aparecer una advertencia de librería opcional `libgssapi_krb5.so.2` ausente. En la prueba local con Kafka plaintext no impidió consumir ni inspeccionar el evento; el equipo de Compras debe revisar la dependencia para otras configuraciones de seguridad.
