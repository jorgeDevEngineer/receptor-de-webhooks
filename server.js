const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 4000;
const API_KEY = process.env.API_KEY || 'mi_clave_secreta_webhook_123';

// Ruta de persistencia local (en Vercel /tmp, en local o Render la carpeta data/)
const STORAGE_DIR = process.env.VERCEL ? os.tmpdir() : path.join(__dirname, 'data');
const STORAGE_FILE = path.join(STORAGE_DIR, 'webhook_history.json');

function loadHistoryFromDisk() {
    try {
        if (fs.existsSync(STORAGE_FILE)) {
            const raw = fs.readFileSync(STORAGE_FILE, 'utf-8');
            const data = JSON.parse(raw);
            if (Array.isArray(data)) return data;
        }
    } catch (e) {
        console.warn('No se pudo leer archivo de historial:', e.message);
    }
    return [];
}

function saveHistoryToDisk(list) {
    try {
        if (!fs.existsSync(STORAGE_DIR)) {
            fs.mkdirSync(STORAGE_DIR, { recursive: true });
        }
        fs.writeFileSync(STORAGE_FILE, JSON.stringify(list, null, 2), 'utf-8');
    } catch (e) {
        console.warn('No se pudo persistir archivo de historial:', e.message);
    }
}

// Normalizar req.url cuando Vercel o proxies reescriben la ruta
app.use((req, res, next) => {
    const matchedPath = req.headers['x-matched-path'];
    if (matchedPath && !matchedPath.includes('/api/index') && !matchedPath.includes('/server.js')) {
        req.url = matchedPath;
    } else if (req.url.startsWith('/server.js')) {
        req.url = req.url.replace('/server.js', '') || '/';
    } else if (req.url.startsWith('/api/index.js')) {
        req.url = req.url.replace('/api/index.js', '') || '/';
    }
    if (!req.url.startsWith('/')) {
        req.url = '/' + req.url;
    }
    next();
});

// Middleware para parsear JSON
app.use(express.json());

// Servir archivos estáticos del frontend
app.use(express.static(path.join(__dirname, 'public')));

// Estado en memoria y disco para pruebas
let simulateFailures = false;
let simulateFailureStatusCode = 500;
const history = global.__webhook_history || loadHistoryFromDisk();
global.__webhook_history = history;

// Middleware de Logging
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${req.method} ${req.url}`);
    next();
});

function getServerStatus() {
    return {
        service: 'Banco Receptor Simulador (Webhook Celupagos V1.0)',
        status: 'ONLINE',
        port: PORT,
        configuredApiKey: API_KEY,
        simulateFailures,
        totalNotificationsReceived: history.length,
        endpoints: {
            dashboard: 'GET /',
            webhook: 'POST /webhooks/pagos',
            health: 'GET /health',
            history: 'GET /history',
            clearHistory: 'POST /history/clear',
            toggleFailures: 'POST /config/toggle-fail'
        }
    };
}

// 1. Endpoint Principal: Dashboard Web o JSON de Estado
app.get('/', (req, res) => {
    if (req.headers.accept && req.headers.accept.includes('text/html')) {
        return res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
    res.json(getServerStatus());
});

app.get('/api/status', (req, res) => {
    res.json(getServerStatus());
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

    // Registrar en histórico en memoria y disco
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
    saveHistoryToDisk(history);

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
    // Si la memoria de la instancia está vacía, refrescar desde disco
    if (history.length === 0) {
        const diskItems = loadHistoryFromDisk();
        if (diskItems.length > 0) {
            history.push(...diskItems);
        }
    }
    res.json({
        total: history.length,
        notifications: history
    });
});

app.post('/history/clear', (req, res) => {
    history.length = 0;
    saveHistoryToDisk(history);
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

// Exportar app para despliegues Serverless (como Vercel) y pruebas
module.exports = app;

// Iniciar Servidor únicamente si se ejecuta directamente con `node server.js`
if (require.main === module) {
    app.listen(PORT, () => {
        console.log('============================================================');
        console.log(`BANCO RECEPTOR SIMULADOR EN LINEA`);
        console.log(`Puerto:                http://localhost:${PORT}`);
        console.log(`Webhook URL:           http://localhost:${PORT}/webhooks/pagos`);
        console.log(`API Key Requerida:     ${API_KEY}`);
        console.log(`Modo Simulacion Fallo: ${simulateFailures ? 'ACTIVADO' : 'DESACTIVADO'}`);
        console.log('============================================================');
    });
}
