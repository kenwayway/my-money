import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initDb, DB_PATH } from "./db/connection.js";
import { seedDb } from "./db/seed.js";
import { accountsRoute } from "./routes/accounts.js";
import { categoriesRoute } from "./routes/categories.js";
import { transactionsRoute } from "./routes/transactions.js";
import { statementsRoute } from "./routes/statements.js";
import { summaryRoute } from "./routes/summary.js";
import { categorizeRoute } from "./routes/categorize.js";
import { settingsRoute, fxRoute, rulesRoute } from "./routes/settings.js";

const PORT = Number(process.env.PORT ?? 4321);

initDb();
seedDb();

const app = new Hono();

app.route("/api/accounts", accountsRoute);
app.route("/api/categories", categoriesRoute);
app.route("/api/transactions", transactionsRoute);
app.route("/api/statements", statementsRoute);
app.route("/api/summary", summaryRoute);
app.route("/api/categorize", categorizeRoute);
app.route("/api/settings", settingsRoute);
app.route("/api/fx-rates", fxRoute);
app.route("/api/merchant-rules", rulesRoute);
app.get("/api/health", (c) => c.json({ ok: true, db: DB_PATH }));

// Serve the built frontend when it exists (production / npm start)
const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(here, "..", "..", "web", "dist");
if (fs.existsSync(webDist)) {
  const relRoot = path.relative(process.cwd(), webDist).replace(/\\/g, "/");
  app.use("/*", serveStatic({ root: relRoot }));
  app.get("*", serveStatic({ root: relRoot, path: "index.html" }));
}

// Financial data, no auth — never expose beyond this machine.
serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" }, (info) => {
  const url = `http://localhost:${info.port}`;
  console.log(`my-money server: ${url}  (db: ${DB_PATH})`);
  if (fs.existsSync(webDist) && process.env.NO_OPEN !== "1") {
    // Windows: open the default browser
    exec(`start "" "${url}"`);
  }
});
