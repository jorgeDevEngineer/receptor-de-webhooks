const express = require('express');

const app = express();
const PORT = process.env.PORT || 4000;
const API_KEY = process.env.API_KEY || 'mi_clave_secreta_webhook_123';

// Middleware para parsear JSON
app.use(express.json());

// Estado en memoria para pruebas
let simulateFailures = false;
let simulateFailureStatusCode = 500;
const history = [];

// Middleware de Logging
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${req.method} ${req.url}`);
    next();
});

// 1. Endpoint Principal de Salud / Estado
app.get('/', (req, res) => {
    res.json({
        service: 'Banco Receptor Simulador (Webhook Celupagos V1.0)',
        status: 'ONLINE',
        port: PORT,
        configuredApiKey: API_KEY,
        simulateFailures,
        totalNotificationsReceived: history.length,
        endpoints: {
            webhook: 'POST /webhooks/pagos',
            health: 'GET /health',
            history: 'GET /history',
            clearHistory: 'POST /history/clear',
            toggleFailures: 'POST /config/toggle-fail'
        }
    });
});

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'OK', uptime: process.uptime() });
});

// 2. Endpoint Oficial de Recepción de Webhooks Celupagos
const webhookHandler = (req, res) => {
    const clientKey = req.headers['x-api-key'] || (req.headers['authorization']?.replace('Bearer ', ''));
    
    // Validación de autenticidad por API Key
    if (!clientKey || clientKey.trim() !== API_KEY) {
        console.warn(`[ALERTA SEGURIDAD] Acceso no autorizado. API Key recibida: "${clientKey}" (Esperada: "${API_KEY}")`);
        return res.status(401).json({
            success: false,
            error: 'No autorizado: API Key invalida o ausente en cabecera x-api-key'
        });
    }

    // Simulación controlada de fallos para probar reintentos
    if (simulateFailures) {
        console.warn(`[SIMULACION DE ERROR] Respondiendo con HTTP ${simulateFailureStatusCode} segun configuracion de prueba.`);
        return res.status(simulateFailureStatusCode).json({
            success: false,
            error: `Simulacion de fallo activada en servidor (HTTP ${simulateFailureStatusCode})`
        });
    }

    const payload = req.body || {};
    const { evento, transaccion, origen, destino, bancoReceptor } = payload;

    const fechaRecepcion = new Date().toISOString();
    const referencia = transaccion?.referencia || 'SIN_REFERENCIA';
    const monto = transaccion?.monto || '0.00';
    const moneda = transaccion?.moneda || 'VES';
    const pagador = origen?.identificacion ? `${origen?.tipoIdentificacion || ''}${origen?.identificacion}` : 'NO_ESPECIFICADO';
    const telefonoPagador = origen?.telefono || 'N/A';
    const bancoEmisor = transaccion?.bancoOrigen || origen?.banco || 'N/A';
    const comercioDestino = destino?.idComercio || 'N/A';

    console.log('\n============================================================');
    console.log(`[PAGO RECIBIDO EXITOSAMENTE] Ref: ${referencia}`);
    console.log(`- Fecha/Hora Servidor: ${fechaRecepcion}`);
    console.log(`- Evento:              ${evento}`);
    console.log(`- Monto:               ${monto} ${moneda}`);
    console.log(`- Banco Emisor:        ${bancoEmisor}`);
    console.log(`- Banco Receptor:      ${bancoReceptor || transaccion?.bancoDestino || 'N/A'}`);
    console.log(`- Pagador:             ${pagador} (Tel: ${telefonoPagador})`);
    console.log(`- Destino (Comercio):  ${comercioDestino}`);
    console.log(`- Concepto:            ${transaccion?.concepto || 'Sin concepto'}`);
    console.log('------------------------------------------------------------');
    console.log('Payload JSON Completo:\n', JSON.stringify(payload, null, 2));
    console.log('============================================================\n');

    // Registrar en histórico en memoria
    history.unshift({
        receivedAt: fechaRecepcion,
        referencia,
        monto,
        moneda,
        pagador,
        comercioDestino,
        payload
    });

    if (history.length > 100) {
        history.pop();
    }

    // Respuesta esperada según Estándar V1.0
    return res.status(200).json({
        success: true,
        message: 'Notificacion recibida y procesada exitosamente',
        referencia,
        processedAt: fechaRecepcion
    });
};

// Rutas de webhook (principal y alias comunes)
app.post('/webhooks/pagos', webhookHandler);
app.post('/webhook', webhookHandler);
app.post('/payment/push/notification', webhookHandler);

// 3. Consultar Histórico de Notificaciones
app.get('/history', (req, res) => {
    res.json({
        total: history.length,
        notifications: history
    });
});

app.post('/history/clear', (req, res) => {
    history.length = 0;
    res.json({ success: true, message: 'Historial de notificaciones limpiado.' });
});

// 4. Controlador de Fallos para Probar Reintentos de Celupagos
app.post('/config/toggle-fail', (req, res) => {
    simulateFailures = !simulateFailures;
    if (req.body?.statusCode) {
        simulateFailureStatusCode = parseInt(req.body.statusCode, 10) || 500;
    }
    console.log(`[CONFIG] Modo simulacion de fallos: ${simulateFailures ? `ACTIVADO (Status ${simulateFailureStatusCode})` : 'DESACTIVADO (200 OK Normal)'}`);
    res.json({
        success: true,
        simulateFailures,
        statusCode: simulateFailureStatusCode,
        message: simulateFailures
            ? `El servidor ahora respondera con error ${simulateFailureStatusCode} para forzar reintentos en Celupagos.`
            : 'El servidor ahora respondera normalmente con 200 OK.'
    });
});

// Iniciar Servidor
app.listen(PORT, () => {
    console.log('============================================================');
    console.log(`BANCO RECEPTOR SIMULADOR EN LINEA`);
    console.log(`Puerto:                http://localhost:${PORT}`);
    console.log(`Webhook URL:           http://localhost:${PORT}/webhooks/pagos`);
    console.log(`API Key Requerida:     ${API_KEY}`);
    console.log(`Modo Simulacion Fallo: ${simulateFailures ? 'ACTIVADO' : 'DESACTIVADO'}`);
    console.log('============================================================');
});
