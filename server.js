const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve static dashboard HTML
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'web_control_dashboard.html'));
});

let clients = new Set();
let currentFeatureStates = {};

function broadcastStats() {
    const statsMsg = JSON.stringify({
        type: 'stats',
        onlineCount: clients.size,
        timestamp: Date.now()
    });
    for (let client of clients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(statsMsg);
        }
    }
}

wss.on('connection', (ws, req) => {
    const clientIp = req.socket.remoteAddress;
    console.log(`[+] Client connected from ${clientIp}. Total connected: ${clients.size + 1}`);
    clients.add(ws);

    // Send initial state & stats to newly connected client
    ws.send(JSON.stringify({
        type: 'init_state',
        states: currentFeatureStates,
        onlineCount: clients.size
    }));

    broadcastStats();

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            // Heartbeat response
            if (data.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
                return;
            }

            console.log('[>] Command received:', data);

            // Cache feature states for state sync
            if (data.type === 'feature' && data.code !== undefined) {
                currentFeatureStates[data.code] = data.value;
            } else if (data.type === 'preset') {
                if (data.states && typeof data.states === 'object') {
                    Object.assign(currentFeatureStates, data.states);
                }
            }

            // Broadcast command to all other connected instances
            for (let client of clients) {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify(data));
                }
            }
        } catch (e) {
            console.error('[-] Error processing message:', e);
        }
    });

    ws.on('close', () => {
        clients.delete(ws);
        console.log(`[-] Client disconnected. Total remaining: ${clients.size}`);
        broadcastStats();
    });

    ws.on('error', (err) => {
        console.error('[-] WebSocket error:', err.message);
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`[+] ADI CHEATS Control Server running on port ${PORT}`);
    console.log(`[+] Dashboard: http://localhost:${PORT}`);
    console.log(`====================================================`);
});

