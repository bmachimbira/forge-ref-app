import express from "express";
import pg from "pg";
import Redis from "ioredis";
import { nanoid } from "nanoid";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Config from env vars ---

const APP_NAME = process.env.APP_NAME || "Snip";
const SHORT_ID_LENGTH = parseInt(process.env.SHORT_ID_LENGTH || "8", 10);
const CACHE_TTL = parseInt(process.env.CACHE_TTL_SECONDS || "3600", 10);
const MAX_LINKS_PER_PAGE = parseInt(process.env.MAX_LINKS_PER_PAGE || "20", 10);
const ENABLE_API = process.env.ENABLE_API !== "false";

console.log("config:", { APP_NAME, SHORT_ID_LENGTH, CACHE_TTL, MAX_LINKS_PER_PAGE, ENABLE_API });

// --- Clients ---

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const redis = new Redis(process.env.REDIS_URL);

// --- DB bootstrap ---

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS links (
      id          TEXT PRIMARY KEY,
      url         TEXT NOT NULL,
      clicks      INTEGER NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_links_created ON links (created_at DESC);
  `);
  console.log("migration done");
}

// --- Helpers ---

async function resolveLink(id) {
  // try redis first
  const cached = await redis.get(`link:${id}`);
  if (cached) return cached;

  const { rows } = await pool.query("SELECT url FROM links WHERE id = $1", [id]);
  if (rows.length === 0) return null;

  await redis.set(`link:${id}`, rows[0].url, "EX", CACHE_TTL);
  return rows[0].url;
}

// --- HTML template ---

function page(body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${APP_NAME} — URL Shortener</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:2rem 1rem}
    h1{font-size:2rem;margin-bottom:.25rem}
    .sub{color:#94a3b8;margin-bottom:2rem}
    form{display:flex;gap:.5rem;width:100%;max-width:600px;margin-bottom:2rem}
    input[type=url]{flex:1;padding:.75rem 1rem;border-radius:.5rem;border:1px solid #334155;background:#1e293b;color:#e2e8f0;font-size:1rem}
    button{padding:.75rem 1.5rem;border-radius:.5rem;border:none;background:#6366f1;color:#fff;font-weight:600;cursor:pointer;font-size:1rem}
    button:hover{background:#4f46e5}
    .result{background:#1e293b;border:1px solid #334155;border-radius:.5rem;padding:1rem 1.5rem;max-width:600px;width:100%;margin-bottom:2rem;word-break:break-all}
    .result a{color:#818cf8}
    table{border-collapse:collapse;max-width:700px;width:100%}
    th,td{text-align:left;padding:.5rem 1rem;border-bottom:1px solid #1e293b}
    th{color:#94a3b8;font-size:.85rem;text-transform:uppercase;letter-spacing:.05em}
    td a{color:#818cf8;text-decoration:none}
    .clicks{text-align:right;font-variant-numeric:tabular-nums}
    .health{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
    .up{background:#34d399}
    .down{background:#f87171}
    .status-bar{display:flex;gap:1.5rem;margin-bottom:2rem;font-size:.9rem;color:#94a3b8}
  </style>
</head>
<body>
  <h1>${APP_NAME}</h1>
  <p class="sub">URL Shortener — Forge Reference App</p>
  ${body}
</body>
</html>`;
}

// --- Routes ---

// Debug: show which env vars the app received (safe — only shows names + custom values)
app.get("/debug/env", (_req, res) => {
  const safeKeys = ["APP_NAME", "SHORT_ID_LENGTH", "CACHE_TTL_SECONDS", "MAX_LINKS_PER_PAGE", "ENABLE_API"];
  const present = Object.keys(process.env)
    .filter((k) => ["DATABASE_URL", "REDIS_URL", "S3_ENDPOINT", "S3_ACCESS_KEY", "S3_BUCKET", "PORT"].includes(k))
    .map((k) => ({ key: k, value: "(set)" }));
  const custom = safeKeys.map((k) => ({ key: k, value: process.env[k] || "(not set)" }));
  res.json({ injected: present, custom });
});

// Health / status
app.get("/health", async (_req, res) => {
  const checks = { postgres: false, redis: false };
  try {
    await pool.query("SELECT 1");
    checks.postgres = true;
  } catch {}
  try {
    await redis.ping();
    checks.redis = true;
  } catch {}
  const ok = checks.postgres && checks.redis;
  res.status(ok ? 200 : 503).json({ status: ok ? "healthy" : "degraded", checks });
});

// Home page
app.get("/", async (_req, res) => {
  const { rows } = await pool.query(
    "SELECT id, url, clicks, created_at FROM links ORDER BY created_at DESC LIMIT $1",
    [MAX_LINKS_PER_PAGE]
  );

  const pgOk = await pool.query("SELECT 1").then(() => true).catch(() => false);
  const redisOk = await redis.ping().then(() => true).catch(() => false);

  const statusBar = `
    <div class="status-bar">
      <span><span class="health ${pgOk ? "up" : "down"}"></span>Postgres</span>
      <span><span class="health ${redisOk ? "up" : "down"}"></span>Redis</span>
    </div>`;

  const form = `<form method="POST" action="/shorten">
    <input type="url" name="url" placeholder="https://example.com/very/long/url" required>
    <button type="submit">Shorten</button>
  </form>`;

  const tableRows = rows
    .map(
      (r) =>
        `<tr>
          <td><a href="/${r.id}">/${r.id}</a></td>
          <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.url}</td>
          <td class="clicks">${r.clicks}</td>
        </tr>`
    )
    .join("");

  const table =
    rows.length > 0
      ? `<table><thead><tr><th>Short</th><th>Destination</th><th style="text-align:right">Clicks</th></tr></thead><tbody>${tableRows}</tbody></table>`
      : `<p style="color:#64748b">No links yet. Create one above!</p>`;

  res.send(page(statusBar + form + table));
});

// Create short link (form POST)
app.post("/shorten", async (req, res) => {
  const url = req.body.url?.trim();
  if (!url) return res.status(400).send("url required");

  const id = nanoid(SHORT_ID_LENGTH);
  await pool.query("INSERT INTO links (id, url) VALUES ($1, $2)", [id, url]);

  const host = req.get("host");
  const proto = req.get("x-forwarded-proto") || req.protocol;
  const shortUrl = `${proto}://${host}/${id}`;

  const result = `<div class="result">
    Short URL: <a href="${shortUrl}">${shortUrl}</a>
  </div>`;

  const form = `<form method="POST" action="/shorten">
    <input type="url" name="url" placeholder="https://example.com/very/long/url" required>
    <button type="submit">Shorten</button>
  </form>`;

  res.send(page(result + form));
});

// JSON API (gated by ENABLE_API env var)
if (ENABLE_API) {
  app.post("/api/links", async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "url required" });

    const id = nanoid(SHORT_ID_LENGTH);
    const { rows } = await pool.query(
      "INSERT INTO links (id, url) VALUES ($1, $2) RETURNING *",
      [id, url]
    );
    res.status(201).json(rows[0]);
  });

  app.get("/api/links", async (_req, res) => {
    const { rows } = await pool.query(
      "SELECT * FROM links ORDER BY created_at DESC LIMIT 50"
    );
    res.json(rows);
  });
}

// Redirect
app.get("/:id", async (req, res) => {
  const url = await resolveLink(req.params.id);
  if (!url) return res.status(404).send("not found");

  // bump clicks async — fire and forget to pg + redis
  pool.query("UPDATE links SET clicks = clicks + 1 WHERE id = $1", [req.params.id]);
  redis.incr(`clicks:${req.params.id}`);

  res.redirect(302, url);
});

// --- Start ---

const PORT = process.env.PORT || 3000;

migrate()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`snip listening on :${PORT}`);
    });
  })
  .catch((err) => {
    console.error("startup failed", err);
    process.exit(1);
  });
