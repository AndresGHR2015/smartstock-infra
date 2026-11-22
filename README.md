# SmartStock · Infraestructura e integración

Repositorio que reúne la configuración local, los manifiestos de Kubernetes y los contratos compartidos del MVP de SmartStock. El sistema tiene tres microservicios de negocio y tres componentes de aplicación que los conectan con el operador.

## Repositorios del proyecto

Clona los repositorios como carpetas hermanas dentro de `SmartStock/`.

| Repositorio | Responsabilidad |
|---|---|
| `smartstock-inventory` | Inventario en Go. |
| `smartstock-sales` | Ventas en Java. |
| `smartstock-purchasing` | Compras en C# y .NET. |
| `smartstock-gateway` | BFF en NestJS. |
| `smartstock-web` | Interfaz en React. |
| `smartstock-mcp` | Agente y servidor MCP en Node.js. |
| `smartstock-infra` | Docker Compose, Kubernetes y contratos compartidos. |

## Integración del MVP

1. El frontend registra una venta mediante GraphQL en el Gateway.
2. El Gateway usa gRPC para llamar a Ventas, que solicita a Inventario el descuento por gRPC.
3. Al cruzar el umbral de stock, Inventario publica `inventory.stock_low.v1` en Kafka. Compras consume la alerta.
4. El Gateway inicia por REST un análisis que usa herramientas MCP para consultar datos y solicitar un borrador.
5. El operador aprueba el borrador desde la interfaz. El Gateway se comunica con Compras por Kafka.

## Entornos y contratos

- **Docker Compose** levanta el entorno local cuando estén disponibles los Dockerfiles y el archivo `compose.yaml`.
- **Kubernetes con kind y Kustomize** aloja y configura el despliegue de demostración.
- **PostgreSQL** aloja bases separadas, con credenciales propias, para Inventario, Ventas y Compras.
- **Contratos** se versionan en `contracts/`. El primer contrato acordado es `contracts/proto/inventory/v1/inventory.proto`.
- **GitHub Actions y GHCR** se usarán para los pipelines por repositorio y el registro de imágenes. Cada microservicio se compila y prueba por separado, con una cobertura mínima del 60 %.

## Primer hito

Demostrar que una venta descuenta stock y que Compras recibe por Kafka la alerta generada al cruzar el umbral. La demo final agrega la propuesta mediante MCP y la aprobación por GraphQL.
