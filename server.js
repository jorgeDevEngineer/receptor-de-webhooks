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
const CONFIG_FILE = path.join(STORAGE_DIR, 'webhook_config.json');

function loadConfigFromDisk() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
            return JSON.parse(raw);
        }
    } catch (e) {
        // ignore
    }
    return { simulateFailures: false, statusCode: 500, clearedAt: 0 };
}

function saveConfigToDisk(cfg) {
    try {
        if (!fs.existsSync(STORAGE_DIR)) {
            fs.mkdirSync(STORAGE_DIR, { recursive: true });
        }
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
    } catch (e) {
        // ignore
    }
}

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

// Estado inicial sincronizado con disco
const initialCfg = loadConfigFromDisk();
let simulateFailures = !!initialCfg.simulateFailures;
let simulateFailureStatusCode = initialCfg.statusCode || 500;
const history = global.__webhook_history || loadHistoryFromDisk();
global.__webhook_history = history;

// Middleware de Logging
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${req.method} ${req.url}`);
    next();
});

function getServerStatus() {
    const cfg = loadConfigFromDisk();
    return {
        service: 'Banco Receptor Simulador (Webhook Celupagos V1.0)',
        status: 'ONLINE',
        port: PORT,
        configuredApiKey: API_KEY,
        simulateFailures: !!cfg.simulateFailures,
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

    // Cargar config fresca desde disco por si otra instancia la modificó
    const cfg = loadConfigFromDisk();
    const isFail = cfg.simulateFailures || simulateFailures;
    const failCode = cfg.statusCode || simulateFailureStatusCode || 500;

    // Simulación controlada de fallos para probar reintentos
    if (isFail) {
        console.warn(`\n[SIMULACION DE ERROR ACTIVA] Rechazando pago con HTTP ${failCode}. Ref: ${referencia}`);
        
        // Registrar intento fallido para visibilidad en tiempo real en el Dashboard
        history.unshift({
            receivedAt: fechaRecepcion,
            referencia,
            monto,
            moneda,
            pagador,
            comercioDestino,
            isError: true,
            httpStatus: failCode,
            payload
        });
        if (history.length > 100) history.pop();
        saveHistoryToDisk(history);

        return res.status(failCode).json({
            success: false,
            error: `Simulacion de fallo activada en servidor (HTTP ${failCode})`,
            referencia,
            processedAt: fechaRecepcion
        });
    }

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
        isError: false,
        httpStatus: 200,
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
    const cfg = loadConfigFromDisk();
    if (history.length === 0) {
        const diskItems = loadHistoryFromDisk();
        if (diskItems.length > 0) {
            history.push(...diskItems);
        }
    }
    let list = history;
    if (cfg.clearedAt && cfg.clearedAt > 0) {
        list = list.filter(it => new Date(it.receivedAt).getTime() > cfg.clearedAt);
    }
    res.json({
        total: list.length,
        notifications: list,
        simulateFailures: !!cfg.simulateFailures,
        clearedAt: cfg.clearedAt || 0
    });
});

app.post('/history/clear', (req, res) => {
    history.length = 0;
    saveHistoryToDisk([]);
    const cfg = loadConfigFromDisk();
    cfg.clearedAt = req.body?.clearedAt || Date.now();
    saveConfigToDisk(cfg);
    res.json({ success: true, message: 'Historial de notificaciones limpiado.', clearedAt: cfg.clearedAt });
});

// 4. Controlador de Fallos para Probar Reintentos de Celupagos
app.post('/config/toggle-fail', (req, res) => {
    const cfg = loadConfigFromDisk();
    cfg.simulateFailures = !cfg.simulateFailures;
    simulateFailures = cfg.simulateFailures;
    if (req.body?.statusCode) {
        cfg.statusCode = parseInt(req.body.statusCode, 10) || 500;
        simulateFailureStatusCode = cfg.statusCode;
    }
    saveConfigToDisk(cfg);
    console.log(`[CONFIG] Modo simulacion de fallos: ${cfg.simulateFailures ? `ACTIVADO (Status ${cfg.statusCode || 500})` : 'DESACTIVADO (200 OK Normal)'}`);
    res.json({
        success: true,
        simulateFailures: cfg.simulateFailures,
        statusCode: cfg.statusCode || 500,
        message: cfg.simulateFailures
            ? `El servidor ahora respondera con error ${cfg.statusCode || 500} para forzar reintentos en Celupagos.`
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
