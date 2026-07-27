// Load environment variables from .env file FIRST
import 'dotenv/config';

import express from 'express';
import path from 'node:path';
import cors from 'cors';
import cookieParser from 'cookie-parser';

// Import the database module (this will also trigger initialization)
import './db/index.js';

// Import Vertex service but don't initialize yet - will be done after DB is ready
import * as vertexService from './services/vertexProxyService.js';

// Note: schedulerService is imported lazily in routes/adminApi.ts to avoid database initialization issues

// Import route handlers
import authRoutes from './routes/auth.js';
import adminApiRoutes from './routes/adminApi.js';
import apiV1Routes from './routes/apiV1.js';
import geminiNativeRoutes from './routes/geminiNative.js';

// Import services and utils (ensure proxyPool is imported to trigger its initialization)
import './services/geminiProxyService.js'; // Still need to import this for other initializations if any
import * as proxyPool from './utils/proxyPool.js';

// Import middleware
import requireAdminAuth from './middleware/adminAuth.js';

const app = express();
const port = Number(process.env.PORT || 3000); // Default to 3000 if PORT not set
const projectRoot = process.cwd();

// --- Middleware ---

// Enable CORS for all origins (adjust for production if needed)
app.use(cors({
    origin: '*', // Allow all origins for now
    credentials: true, // Allow cookies for authenticated requests (like admin UI)
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-requested-with', 'x-goog-api-key'],
    maxAge: 86400 // Cache preflight requests for 1 day
}));

// Handle OPTIONS preflight requests globally (alternative to handling in each route)
app.options('*', cors());

// Parse JSON request bodies
app.use(express.json({ limit: '100mb' }));

// Parse URL-encoded request bodies
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Parse cookies
app.use(cookieParser());

// Serve static files from the 'public' directory
app.use(express.static(path.join(projectRoot, 'public')));

// --- Basic Routes ---

// Root route: Redirects to /admin/index.html if logged in, otherwise requireAdminAuth redirects to /login.html
app.get('/', (req, res) => {
    res.redirect('/login.html');
});

// Redirect /login to the static HTML file
app.get('/login', (req, res) => {
    res.redirect('/login.html');
});

// Admin route: Protect the route and serve the static file
app.get('/admin', requireAdminAuth, (req, res) => {
    res.redirect('/admin/'); // Redirect to the directory path
});

app.use('/admin', requireAdminAuth, express.static(path.join(projectRoot, 'public', 'admin')));

// --- API Routes ---
app.use('/api', authRoutes);
app.use('/api/admin', requireAdminAuth, adminApiRoutes);
app.use('/v1', apiV1Routes);
app.use('/v1beta', geminiNativeRoutes);

// --- Global Error Handler ---
app.use((err, req, res, next) => {
    console.error('Unhandled Error:', err.stack || err);
    res.status(err.status || 500).json({
        error: {
            message: err.message || 'Internal Server Error',
            type: err.type || 'unhandled_error',
            ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
        }
    });
});

// --- Start Server ---
app.listen(port, '0.0.0.0', async () => {
    console.log(`JimiHub  (Node.js version) listening on port ${port} (all interfaces)`);

    // Log Proxy Pool Status
    const proxyStatus = proxyPool.getProxyPoolStatus(); // Get status from proxyPool module
    if (proxyStatus.enabled) {
        console.log(`Proxy Pool: Enabled (Loaded ${proxyStatus.count} SOCKS5 proxies)`);
    } else if (proxyStatus.count > 0 && !proxyStatus.agentLoaded) {
        console.log(`Proxy Pool: Configured (${proxyStatus.count} proxies) but DISABLED (missing 'socks-proxy-agent' dependency)`);
    } else {
        console.log(`Proxy Pool: Disabled (PROXY environment variable not set or contains no valid SOCKS5 proxies)`);
    }

    // Log Vertex AI Status using the check function
    if (vertexService.isVertexEnabled()) {
        // Check if we're using Express Mode
        if (process.env.EXPRESS_API_KEY) {
            console.log(`Vertex AI: Enabled with Express Mode (API Key authentication, additional [v] prefixed models available)`);
        } else {
            console.log(`Vertex AI: Enabled (Service Account credentials, additional [v] prefixed models available)`);
        }
    } else {
        console.log(`Vertex AI: Disabled (VERTEX variable and EXPRESS_API_KEY not found or invalid in .env file)`);
    }

    // Check if running in Hugging Face Space
    if (process.env.HUGGING_FACE === '1' && process.env.SPACE_HOST) {
        const adminUrl = `https://${process.env.SPACE_HOST}/admin`;
        const endpointUrl = `https://${process.env.SPACE_HOST}/v1`;
        console.log(`Hugging Face Space Admin UI: ${adminUrl}`);
        console.log(`Hugging Face Space Endpoint: ${endpointUrl}`);
    } else {
        // Fallback for local or other environments
        const adminUrl = `http://localhost:${port}/admin`;
        const endpointUrl = `http://localhost:${port}/v1`;
        console.log(`Admin UI available at: ${adminUrl} (or the server's public address)`);
        console.log(`API Endpoint available at: ${endpointUrl} (or the server's public address)`);
    }
});

