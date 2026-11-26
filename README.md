# SmartStock · Infraestructura e integración

Repositorio de integración de SmartStock, una aplicación distribuida para gestionar inventario, ventas y compras con reposición asistida por IA. Centraliza los contratos entre servicios y la configuración para ejecutar el proyecto en local y en Kubernetes.

**Stack** · Docker Compose, Kubernetes con kind, Kustomize, PostgreSQL, Apache Kafka en modo KRaft, GitHub Actions y GHCR.

## Repositorios

Los repositorios se clonan como carpetas hermanas bajo `SmartStock/`.

| Repositorio | Componente |
|---|---|
| `smartstock-inventario` | Microservicio de existencias en Go. |
| `smartstock-ventas` | Microservicio de ventas en Java y Spring Boot. |
| `smartstock-compras` | Microservicio de abastecimiento en C# y .NET. |
| `smartstock-gateway` | API Gateway y BFF en NestJS. |
| `smartstock-front` | Interfaz web en React y TypeScript. |
| `smartstock-mcp` | Agente de reposición y servidor MCP. |
| `smartstock-infra` | Entornos, despliegue y contratos compartidos. |

## Arquitectura

```mermaid
flowchart TD
    F["Frontend"] -->|"GraphQL"| G["Gateway"]
    G -->|"gRPC"| I["Inventario"]
    G -->|"gRPC"| V["Ventas"]
    G <-->|"Kafka"| C["Compras"]
    G <-->|"REST interno"| M["Agente y servidor MCP"]
    V -->|"gRPC"| I
    I -->|"Kafka"| C
```

El Gateway expone el acceso al frontend. Inventario, Ventas, Compras y el registro asíncrono del Gateway mantienen bases PostgreSQL propias. Kafka transporta las alertas de reposición y las solicitudes/resultados de Compras. La integración con el agente MCP sigue pendiente; el diagrama representa también esa arquitectura objetivo.

## Entornos y contratos

- **Docker Compose.** Entorno local de ventas/inventario y del intercambio Gateway–Compras, con una prueba reproducible de las seis operaciones y recuperación tras reinicios; consulta [arranque y demostración](compose/README.md). Kubernetes queda pendiente.
- **Contratos.** `contracts/` contiene las definiciones Protobuf, el esquema GraphQL y los esquemas Kafka de alertas, solicitudes y resultados de Compras. Véase [la guía de contratos](contracts/README.md) para sus reglas, distribución y validación.
- **CI e imágenes.** La integración y el consumo de imágenes versionadas quedan pendientes.

Cada repo de aplicación mantiene su código y sus dependencias. Este repo se ocupa de cómo se conectan y ejecutan juntos.
