# Banco Receptor Simulador - Webhook Pasarela Celupagos

Micro-servicio de prueba en Node.js diseñado para simular el servidor receptor de un comercio afiliado a la pasarela de pagos Celupagos.

Permite verificar la recepción en vivo de notificaciones push de pagos (Estándar Técnico V1.0) emitidas por entidades bancarias (Banco de Venezuela, Venezolano de Crédito, etc.).

---

## 1. Características

* **Validación de Seguridad:** Valida la cabecera `x-api-key` (o `Authorization: Bearer <key>`).
* **Visualización en Consola:** Formatea y muestra los detalles clave de cada transacción recibida (Referencia, Monto, Banco Emisor/Receptor, Pagador, Comercio Destino).
* **Confirmación Inmediata:** Responde con `HTTP 200 OK` y `{ "success": true }` según el estándar oficial.
* **Simulador de Fallos:** Permite alternar la simulación de errores (`HTTP 500`) para auditar la política de reintentos de Celupagos (reintento a los 30 minutos).
* **Histórico en Memoria:** Permite inspeccionar las notificaciones recibidas a través de `GET /history`.

---

## 2. Instalación y Puesta en Marcha

### Prerrequisitos
* Node.js v14 o superior.

### Instalación de dependencias
```bash
npm install
```

### Ejecutar el servidor
```bash
npm start
```
Por defecto escuchará en: `http://localhost:4000`

---

## 3. Endpoints Disponibles

| Método | Ruta | Descripción |
| :--- | :--- | :--- |
| `GET` | `/` | Estado general del servicio, configuración y resumen. |
| `GET` | `/health` | Chequeo de salud del servicio (`200 OK`). |
| `POST` | `/webhooks/pagos` | Endpoint oficial para recibir notificaciones de Celupagos. |
| `GET` | `/history` | Lista JSON con todas las notificaciones recibidas. |
| `POST` | `/history/clear` | Limpia el historial en memoria. |
| `POST` | `/config/toggle-fail` | Activa o desactiva la simulación de errores (para probar reintentos). |

---

## 4. Configuración (Variables de Entorno)

Crea un archivo `.env` o exporta las variables:

```env
PORT=4000
API_KEY=mi_clave_secreta_webhook_123
```

---

## 5. Exponer a Internet para Pruebas con Celupagos (QA / Producción)

Para que el servidor de Celupagos pueda alcanzar este simulador local, puedes exponerlo públicamente con herramientas como `ngrok`, `localtunnel` o desplegarlo en un servicio cloud:

### Opción A: Vía ngrok
```bash
ngrok http 4000
```
La URL generada (ejemplo: `https://xxxx.ngrok-free.app/webhooks/pagos`) será la que ingreses en el portal de certificación de Celupagos:
`https://<dominio-celupagos>/payment/push/tester`

---

## 6. Probar Simulación de Fallos

Para comprobar que Celupagos aplica correctamente la política de reintentos (2do intento a los 30 minutos):

```bash
curl -X POST http://localhost:4000/config/toggle-fail
```
Esto hará que el simulador empiece a responder con `HTTP 500 Internal Server Error`, obligando a Celupagos a marcar la transacción como pendiente de reintento.
