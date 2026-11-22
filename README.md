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

El Gateway expone el acceso al frontend. Inventario, Ventas y Compras mantienen bases PostgreSQL propias. Kafka transporta las alertas de reposición y los mensajes de Compras. El agente usa herramientas MCP para consultar datos y solicitar borradores que el operador puede aprobar.

## Entornos y contratos

- **Docker Compose.** Configuración para construir y levantar las aplicaciones y sus dependencias en el entorno de desarrollo.
- **Kubernetes.** Manifiestos y configuración de despliegue para ejecutar las imágenes de los componentes en el clúster local.
- **Contratos.** `contracts/` reúne las definiciones Protobuf y los esquemas de mensajes de Kafka. El contrato de Inventario se ubica en `contracts/proto/inventory/v1/inventory.proto`.
- **CI e imágenes.** Cada microservicio mantiene su Dockerfile, su pipeline y la cobertura mínima del 60 %. La integración consume las imágenes versionadas de los componentes.

Cada repo de aplicación mantiene su código y sus dependencias. Este repo se ocupa de cómo se conectan y ejecutan juntos.
