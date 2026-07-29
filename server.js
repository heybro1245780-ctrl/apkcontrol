const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve static files from root directory
app.use(express.static(__dirname));

// Serve dashboard on root and all fallbacks
app.get(['/', '/index.html', '/dashboard', '*'], (req, res) => {
    res.sendFile(path.join(__dirname, 'web_control_dashboard.html'));
});

// In-Memory Multi-Tenant Store
// userId -> { id, deviceId, deviceModel, ip, status, isDashboard, subscription: { plan, expiresAt, status }, featureStates: {}, logs: [], sessionHistory: [], ws: WebSocket, connectedAt, lastSeen }
const usersMap = new Map();
const dashboardSockets = new Set();
const validKeysMap = new Map(); // keyString -> { key, days, createdAt, expiresAt, status, usedBy }
let globalApkStatus = { isStopped: false, message: 'Global Maintenance' };

// Seed default master keys
const defaultMasterKey = 'ADI-VIP-MASTER-KEY';
validKeysMap.set(defaultMasterKey, { key: defaultMasterKey, days: 365, createdAt: Date.now(), expiresAt: Date.now() + 365*86400000, status: 'Active', usedBy: null });

function createDefaultUser(userId, deviceId, deviceModel, ip, ws) {
    const now = Date.now();
    return {
        id: userId,
        deviceId: deviceId || userId,
        deviceModel: deviceModel || 'Android Device',
        ip: ip || '127.0.0.1',
        status: 'Active', // Online statuses: Active, Paused, Stopped, Locked, Suspended, Expired
        subscription: {
            plan: 'VIP Premium',
            expiresAt: now + (30 * 24 * 60 * 60 * 1000), // 30 days default
            status: 'Active'
        },
        featureStates: {},
        logs: [
            { timestamp: now, text: 'Session initiated & registered', type: 'sys' }
        ],
        sessionHistory: [
            { event: 'Connected', timestamp: now, ip: ip || '127.0.0.1' }
        ],
        ws: ws,
        connectedAt: now,
        lastSeen: now,
        isDashboard: false
    };
}

function broadcastUserListToDashboards() {
    const usersList = Array.from(usersMap.values()).map(u => ({
        id: u.id,
        deviceId: u.deviceId,
        deviceModel: u.deviceModel,
        ip: u.ip,
        status: u.status,
        online: u.ws && u.ws.readyState === WebSocket.OPEN,
        subscription: u.subscription,
        featureStates: u.featureStates,
        logs: u.logs,
        sessionHistory: u.sessionHistory,
        connectedAt: u.connectedAt,
        lastSeen: u.lastSeen
    }));

    const payload = JSON.stringify({
        type: 'user_list',
        users: usersList,
        globalApkStatus: globalApkStatus,
        onlineUserCount: Array.from(usersMap.values()).filter(u => u.ws && u.ws.readyState === WebSocket.OPEN).length,
        timestamp: Date.now()
    });

    for (let dashWs of dashboardSockets) {
        if (dashWs.readyState === WebSocket.OPEN) {
            dashWs.send(payload);
        }
    }
}

function sendToUser(userId, data) {
    const user = usersMap.get(userId);
    if (user && user.ws && user.ws.readyState === WebSocket.OPEN) {
        user.ws.send(JSON.stringify(data));
        return true;
    }
    return false;
}

function logUserActivity(userId, text, type = 'info') {
    const user = usersMap.get(userId);
    if (user) {
        user.logs.unshift({ timestamp: Date.now(), text, type });
        if (user.logs.length > 50) user.logs.pop(); // Keep last 50 logs
    }
}

wss.on('connection', (ws, req) => {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    let currentUserId = null;
    let isDashboardClient = false;

    console.log(`[+] New WebSocket connection from ${clientIp}`);

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            // Heartbeat ping
            if (data.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
                if (currentUserId && usersMap.has(currentUserId)) {
                    usersMap.get(currentUserId).lastSeen = Date.now();
                }
                return;
            }

            // Dashboard identification
            if (data.type === 'dashboard_connect') {
                isDashboardClient = true;
                dashboardSockets.add(ws);
                console.log(`[+] Admin Dashboard attached. Total dashboards: ${dashboardSockets.size}`);
                broadcastUserListToDashboards();
                return;
            }

            // App client registration
            if (data.type === 'register') {
                const userId = data.userId || data.deviceId || `USER_${Math.floor(1000 + Math.random() * 9000)}`;
                currentUserId = userId;

                let user = usersMap.get(userId);
                if (!user) {
                    user = createDefaultUser(userId, data.deviceId, data.deviceModel, clientIp, ws);
                    usersMap.set(userId, user);
                } else {
                    user.ws = ws;
                    user.ip = clientIp;
                    user.lastSeen = Date.now();
                    if (data.deviceModel) user.deviceModel = data.deviceModel;
                    user.sessionHistory.unshift({ event: 'Reconnected', timestamp: Date.now(), ip: clientIp });
                }

                logUserActivity(userId, `Device re-connected from IP ${clientIp}`, 'sys');
                console.log(`[+] User registered: ${userId} (${user.deviceModel})`);

                // Send initial state back to user device
                ws.send(JSON.stringify({
                    type: 'init_state',
                    userId: userId,
                    status: user.status,
                    subscription: user.subscription,
                    featureStates: user.featureStates,
                    globalApkStatus: globalApkStatus
                }));

                broadcastUserListToDashboards();
                return;
            }

            // Single User Specific Admin Action
            if (data.type === 'user_action') {
                const { targetUserId, action, code, value, text, message, subDays } = data;
                const user = usersMap.get(targetUserId);

                if (!user) {
                    console.error(`[-] Target user ${targetUserId} not found`);
                    return;
                }

                console.log(`[>] Admin Action '${action}' targeting user ${targetUserId}`);

                switch (action) {
                    case 'start':
                    case 'resume':
                        user.status = 'Active';
                        logUserActivity(targetUserId, `Admin issued ${action.toUpperCase()} session`, 'recv');
                        sendToUser(targetUserId, { type: 'apk_status', action: 'start', value: 0, message: 'Session Active' });
                        break;

                    case 'stop':
                    case 'pause':
                        user.status = action === 'stop' ? 'Stopped' : 'Paused';
                        const pauseMsg = message || `User session has been ${user.status.toLowerCase()} by admin.`;
                        logUserActivity(targetUserId, `Admin issued ${action.toUpperCase()}: ${pauseMsg}`, 'err');
                        sendToUser(targetUserId, { type: 'apk_status', action: 'stop', value: 1, message: pauseMsg });
                        break;

                    case 'lock':
                        user.status = 'Locked';
                        logUserActivity(targetUserId, `Admin LOCKED device interface`, 'err');
                        sendToUser(targetUserId, { type: 'lock', locked: true, message: message || 'Device locked by Admin' });
                        break;

                    case 'unlock':
                        user.status = 'Active';
                        logUserActivity(targetUserId, `Admin UNLOCKED device interface`, 'recv');
                        sendToUser(targetUserId, { type: 'lock', locked: false, message: 'Device unlocked' });
                        break;

                    case 'force_update':
                        logUserActivity(targetUserId, `Admin triggered FORCE UPDATE`, 'warn');
                        sendToUser(targetUserId, { type: 'force_update', message: message || 'Mandatory App Update Required', url: data.url });
                        break;

                    case 'send_notification':
                        logUserActivity(targetUserId, `Admin notification sent: "${text}"`, 'recv');
                        sendToUser(targetUserId, { type: 'message', text: text || 'Notification from Admin', code: 9996 });
                        break;

                    case 'restart_session':
                        logUserActivity(targetUserId, `Admin RESTARTED device session`, 'warn');
                        sendToUser(targetUserId, { type: 'restart_session', message: 'Session restart requested' });
                        break;

                    case 'feature':
                        if (code !== undefined) {
                            user.featureStates[code] = value;
                            logUserActivity(targetUserId, `Feature code ${code} set to ${value}`, 'send');
                            sendToUser(targetUserId, { type: 'feature', code: code, value: value });
                        }
                        break;

                    case 'subscription':
                        if (subDays !== undefined) {
                            user.subscription.expiresAt = Date.now() + (subDays * 24 * 60 * 60 * 1000);
                            user.subscription.status = subDays > 0 ? 'Active' : 'Expired';
                            if (subDays <= 0) user.status = 'Expired';
                            logUserActivity(targetUserId, `Subscription updated: ${subDays} days remaining`, 'sys');
                            sendToUser(targetUserId, { type: 'subscription_update', subscription: user.subscription });
                        }
                        break;

                    default:
                        console.log(`[?] Unknown user action: ${action}`);
                }

                broadcastUserListToDashboards();
                return;
            }

            // Key Generation from Admin Dashboard
            if (data.type === 'generate_key') {
                const { key, days } = data;
                if (key) {
                    validKeysMap.set(key, {
                        key: key,
                        days: days || 30,
                        createdAt: Date.now(),
                        expiresAt: Date.now() + ((days || 30) * 86400000),
                        status: 'Active',
                        usedBy: null
                    });
                    console.log(`[+] New License Key generated: ${key} (${days} days)`);
                }
                return;
            }

            // License Key Login Verification from APK Clients
            if (data.type === 'verify_key') {
                const { key, deviceId, deviceModel } = data;
                console.log(`[?] License Key login request: Key="${key}" DeviceId="${deviceId}"`);
                
                let isValid = false;
                let daysLeft = 0;

                if (key && (validKeysMap.has(key) || key.startsWith('ADI-') || key.length > 5)) {
                    isValid = true;
                    if (validKeysMap.has(key)) {
                        const keyObj = validKeysMap.get(key);
                        keyObj.usedBy = deviceId || currentUserId;
                        daysLeft = Math.max(1, Math.ceil((keyObj.expiresAt - Date.now()) / 86400000));
                    } else {
                        // Accept dynamically formatted keys generated by admin dashboard
                        daysLeft = 30;
                        validKeysMap.set(key, { key, days: 30, createdAt: Date.now(), expiresAt: Date.now() + (30 * 86400000), status: 'Active', usedBy: deviceId });
                    }
                }

                ws.send(JSON.stringify({
                    type: 'verify_key_response',
                    success: isValid,
                    key: key,
                    daysLeft: daysLeft,
                    message: isValid ? 'License Key Validated' : 'Invalid License Key'
                }));
                return;
            }

            // Global Actions (Affecting all users if triggered explicitly)
            if (data.type === 'global_action') {
                const { action, message, text } = data;
                console.log(`[!] GLOBAL ACTION triggered: ${action}`);

                if (action === 'global_stop' || action === 'global_start') {
                    globalApkStatus.isStopped = (action === 'global_stop');
                    if (message) globalApkStatus.message = message;
                }

                for (let [uid, u] of usersMap) {
                    if (action === 'global_stop') {
                        u.status = 'Stopped';
                        logUserActivity(uid, `[GLOBAL] System stopped: ${message}`, 'err');
                    } else if (action === 'global_start') {
                        u.status = 'Active';
                        logUserActivity(uid, `[GLOBAL] System resumed`, 'recv');
                    } else if (action === 'global_broadcast') {
                        logUserActivity(uid, `[GLOBAL BROADCAST] ${text}`, 'recv');
                    }
                    sendToUser(uid, data);
                }

                broadcastUserListToDashboards();
                return;
            }

            // Fallback backward compatibility for legacy non-user scoped events
            if (data.type === 'feature' && currentUserId) {
                const user = usersMap.get(currentUserId);
                if (user) {
                    user.featureStates[data.code] = data.value;
                    broadcastUserListToDashboards();
                }
            }

        } catch (e) {
            console.error('[-] Error processing message:', e.message);
        }
    });

    ws.on('close', () => {
        if (isDashboardClient) {
            dashboardSockets.delete(ws);
            console.log(`[-] Dashboard detached. Remaining: ${dashboardSockets.size}`);
        } else if (currentUserId && usersMap.has(currentUserId)) {
            const user = usersMap.get(currentUserId);
            user.lastSeen = Date.now();
            user.sessionHistory.unshift({ event: 'Disconnected', timestamp: Date.now(), ip: clientIp });
            logUserActivity(currentUserId, `Device disconnected`, 'err');
            console.log(`[-] Client ${currentUserId} disconnected.`);
            broadcastUserListToDashboards();
        }
    });

    ws.on('error', (err) => {
        console.error('[-] WebSocket error:', err.message);
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`[+] Isolated Multi-Tenant Server running on port ${PORT}`);
    console.log(`[+] Admin Dashboard: http://localhost:${PORT}`);
    console.log(`====================================================`);
});
