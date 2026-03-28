import express from "express";
import { createServer } from "http";
import cors from "cors";
import dotenv from "dotenv";
import morgan from "morgan";
import { Horizon } from "@stellar/stellar-sdk";
import swaggerUi from "swagger-ui-express";
import marketRatesRouter from "./routes/marketRates";
import historyRouter from "./routes/history";
import statsRouter from "./routes/stats";
import intelligenceRouter from "./routes/intelligence";
import priceUpdatesRouter from "./routes/priceUpdates";
import assetsRouter from "./routes/assets";
import prisma from "./lib/prisma";
import { initSocket } from "./lib/socket";
import { SorobanEventListener } from "./services/sorobanEventListener";
import { specs } from "./lib/swagger";
import { multiSigSubmissionService } from "./services/multiSigSubmissionService";
import { apiKeyMiddleware } from "./middleware/apiKeyMiddleware";
import { validateEnv } from "./utils/envValidator";
// Load environment variables
dotenv.config();
// [OPS] Implement "Environment Variable" Check on Start
validateEnv();
// Validate required environment variables
const requiredEnvVars = ["STELLAR_SECRET", "DATABASE_URL"];
const missingEnvVars = [];
for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
        missingEnvVars.push(envVar);
    }
}
if (missingEnvVars.length > 0) {
    console.error("❌ Missing required environment variables:");
    missingEnvVars.forEach((varName) => console.error(`   - ${varName}`));
    console.error("\nPlease set these variables in your .env file and restart the server.");
    process.exit(1);
}
const dashboardUrl = process.env.DASHBOARD_URL || process.env.FRONTEND_URL || "http://localhost:3000";
if (!dashboardUrl) {
    console.error("❌ Missing required environment variable: DASHBOARD_URL");
    process.exit(1);
}
const app = express();
const PORT = process.env.PORT || 3000;
// Horizon server for health checks
const stellarNetwork = process.env.STELLAR_NETWORK || "TESTNET";
const horizonUrl = stellarNetwork === "PUBLIC"
    ? "https://horizon.stellar.org"
    : "https://horizon-testnet.stellar.org";
const horizonServer = new Horizon.Server(horizonUrl);
// Middleware
app.use(morgan("dev"));
app.use(cors({
    origin: (origin, callback) => {
        // Allow non-browser requests (e.g. curl, server-to-server)
        if (!origin) {
            return callback(null, true);
        }
        if (origin === dashboardUrl) {
            return callback(null, true);
        }
        return callback(new Error(`CORS policy: Access denied from origin ${origin}. Allowed origin: ${dashboardUrl}`));
    },
    credentials: true,
}));
app.use(express.json());
// Swagger documentation
app.use("/api/docs", swaggerUi.serve);
app.get("/api/docs", swaggerUi.setup(specs, {
    swaggerOptions: {
        persistAuthorization: true,
    },
    customCss: `
    .topbar { display: none; }
    .swagger-ui .api-info { margin-bottom: 20px; }
  `,
    customSiteTitle: "StellarFlow API Documentation",
}));
// Apply API Key Middleware to all /api routes
app.use("/api", apiKeyMiddleware);
// Routes
app.use("/api/market-rates", marketRatesRouter);
app.use("/api/history", historyRouter);
app.use("/api/stats", statsRouter);
app.use("/api/intelligence", intelligenceRouter);
app.use("/api/price-updates", priceUpdatesRouter);
app.use("/api/assets", assetsRouter);
// Health check endpoint
/**
 * @swagger
 * /health:
 *   get:
 *     tags:
 *       - Health
 *     summary: System health check
 *     description: Check the health status of the backend including database and Stellar Horizon connectivity
 *     responses:
 *       '200':
 *         description: All systems operational
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: All systems operational
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                 checks:
 *                   type: object
 *                   properties:
 *                     database:
 *                       type: boolean
 *                     horizon:
 *                       type: boolean
 *       '503':
 *         description: One or more services unavailable
 */
app.get("/health", async (req, res) => {
    const checks = {
        database: false,
        horizon: false,
    };
    // Check database connectivity
    try {
        await prisma.$queryRaw `SELECT 1`;
        checks.database = true;
    }
    catch {
        checks.database = false;
    }
    // Check Stellar Horizon reachability
    try {
        await horizonServer.root();
        checks.horizon = true;
    }
    catch {
        checks.horizon = false;
    }
    const healthy = checks.database && checks.horizon;
    res.status(healthy ? 200 : 503).json({
        success: healthy,
        message: healthy
            ? "All systems operational"
            : "One or more services unavailable",
        timestamp: new Date().toISOString(),
        checks,
    });
});
// Root endpoint
/**
 * @swagger
 * /:
 *   get:
 *     tags:
 *       - Health
 *     summary: API root endpoint
 *     description: Get information about available API endpoints
 *     responses:
 *       '200':
 *         description: API information with available endpoints
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: StellarFlow Backend API
 *                 version:
 *                   type: string
 *                   example: 1.0.0
 *                 endpoints:
 *                   type: object
 */
app.get("/", (req, res) => {
    res.json({
        success: true,
        message: "StellarFlow Backend API",
        version: "1.0.0",
        endpoints: {
            health: "/health",
            marketRates: {
                allRates: "/api/market-rates/rates",
                singleRate: "/api/market-rates/rate/:currency",
                health: "/api/market-rates/health",
                currencies: "/api/market-rates/currencies",
                cache: "/api/market-rates/cache",
                clearCache: "POST /api/market-rates/cache/clear",
            },
            stats: {
                volume: "/api/stats/volume?date=YYYY-MM-DD",
            },
            history: {
                assetHistory: "/api/history/:asset?range=1d|7d|30d|90d",
            },
        },
    });
});
// Error handling middleware
app.use((err, req, res, next) => {
    console.error("Unhandled error:", err);
    res.status(500).json({
        success: false,
        error: "Internal server error",
    });
});
// 404 handler
app.use("*", (req, res) => {
    res.status(404).json({
        success: false,
        error: "Endpoint not found",
    });
});
// Start server
const httpServer = createServer(app);
initSocket(httpServer);
let sorobanEventListener = null;
let isShuttingDown = false;
const closeHttpServer = () => new Promise((resolve, reject) => {
    if (!httpServer.listening) {
        resolve();
        return;
    }
    httpServer.close((error) => {
        if (error) {
            reject(error);
            return;
        }
        resolve();
    });
});
const shutdown = async (signal) => {
    if (isShuttingDown) {
        console.log(`Shutdown already in progress. Received duplicate ${signal} signal.`);
        return;
    }
    isShuttingDown = true;
    console.log(`${signal} received. Starting graceful shutdown...`);
    try {
        sorobanEventListener?.stop();
        multiSigSubmissionService.stop();
        await closeHttpServer();
        console.log("HTTP server closed.");
        await prisma.$disconnect();
        console.log("Database connections closed cleanly.");
        process.exit(0);
    }
    catch (error) {
        console.error("Graceful shutdown failed:", error);
        process.exit(1);
    }
};
process.once("SIGINT", () => {
    shutdown("SIGINT").catch((error) => {
        console.error("Unhandled SIGINT shutdown error:", error);
        process.exit(1);
    });
});
process.once("SIGTERM", () => {
    shutdown("SIGTERM").catch((error) => {
        console.error("Unhandled SIGTERM shutdown error:", error);
        process.exit(1);
    });
});
httpServer.listen(PORT, () => {
    console.log(`🌊 StellarFlow Backend running on port ${PORT}`);
    console.log(`📊 Market Rates API available at http://localhost:${PORT}/api/market-rates`);
    console.log(`📚 API Documentation available at http://localhost:${PORT}/api/docs`);
    console.log(`🏥 Health check at http://localhost:${PORT}/health`);
    console.log(`🔌 Socket.io ready for dashboard connections`);
    // Start Soroban event listener to track confirmed on-chain prices
    try {
        sorobanEventListener = new SorobanEventListener();
        sorobanEventListener.start().catch((err) => {
            console.error("Failed to start event listener:", err);
        });
        console.log(`👂 Soroban event listener started`);
    }
    catch (err) {
        console.warn("Event listener not started:", err instanceof Error ? err.message : err);
        sorobanEventListener = null;
    }
    // Start multi-sig submission service if enabled
    if (process.env.MULTI_SIG_ENABLED === "true") {
        try {
            multiSigSubmissionService.start().catch((err) => {
                console.error("Failed to start multi-sig submission service:", err);
            });
            console.log(`🔐 Multi-Sig submission service started`);
        }
        catch (err) {
            console.warn("Multi-sig submission service not started:", err instanceof Error ? err.message : err);
        }
    }
});
export default app;
//# sourceMappingURL=index.js.map