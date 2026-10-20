import "dotenv/config";
import express from "express";
import path from "path";
import cors from "cors";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import { createServer as createViteServer } from "vite";
import fs from "fs-extra";
import jwt from "jsonwebtoken";
import {
  DEFAULT_SITE_URL,
  absoluteUrl,
  canonicalPath,
  getSeoRoute,
  isNoindexPath,
  renderSeoBody,
  renderMetaTags,
  seoRoutes,
} from "./src/website/seo.js";

const app = express();
const httpServer = createServer(app);
export const io = new SocketIOServer(httpServer, {
  cors: { origin: "*" },
});
app.set("io", io);

// Initialize data folders
const DATA_DIR = path.join(process.cwd(), ".data");
const SERVERS_DIR = path.join(DATA_DIR, "servers");
const BACKUPS_DIR = path.join(process.cwd(), "backups");

fs.ensureDirSync(DATA_DIR);
fs.ensureDirSync(SERVERS_DIR);
fs.ensureDirSync(BACKUPS_DIR);
fs.ensureDirSync(path.join(DATA_DIR, "temp"));

if (!fs.existsSync(path.join(DATA_DIR, "users.json"))) fs.writeFileSync(path.join(DATA_DIR, "users.json"), "[]");
if (!fs.existsSync(path.join(DATA_DIR, "servers.json"))) fs.writeFileSync(path.join(DATA_DIR, "servers.json"), "[]");
if (!fs.existsSync(path.join(DATA_DIR, "settings.json"))) fs.writeFileSync(path.join(DATA_DIR, "settings.json"), "{}");

import { attachContainerSocket, getContainerLogs } from "./src/server/services/docker.js";
import { panelEvents } from "./src/server/events.js";
import { getLocalServerLogs } from "./src/server/services/local.js";

panelEvents.on("log", (serverId: string, logData: string) => {
  io.to(`server_${serverId}`).emit("log", logData);
});

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error("Authentication error"));
  try {
    const verified = jwt.verify(token, process.env.JWT_SECRET || "lixcloud-panel-super-secret");
    (socket as any).user = verified;
    next();
  } catch (err) {
    next(new Error("Authentication error"));
  }
});

io.on("connection", (socket) => {
  socket.on("joinServer", async (serverId) => {
    socket.join(`server_${serverId}`);
    
    // Stream initial logs whether local runtime or docker
    try {
      const serversJSON = await fs.readFile(path.join(DATA_DIR, "servers.json"), "utf8");
      const servers = JSON.parse(serversJSON);
      const server = Array.isArray(servers) ? servers.find((s: any) => s.id === serverId) : null;
      
      // Check local logs first
      const localLogs = await getLocalServerLogs(serverId);
      if (localLogs) {
        socket.emit("log", localLogs.trim() + "\n");
      }

      if (server && server.containerId && !String(server.containerId).startsWith("local-")) {
        const logs = await getContainerLogs(server.containerId);
        if (logs) {
           socket.emit("log", logs.trim() + "\n");
        }
        await attachContainerSocket(server.containerId, serverId);
      }
    } catch (e) {
      console.error("Error fetching logs for server", serverId, e);
    }
  });
  socket.on("leaveServer", (serverId) => {
    socket.leave(`server_${serverId}`);
  });
});

// STRICT ROUTING: 3000 for Admin/Dev, 6767 for Main/Prod
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : (process.env.NODE_ENV === "development" ? 3000 : 6767);
const isDev = process.env.NODE_ENV === "development" && PORT === 3000;
const siteUrl = process.env.ZYNTIXCLOUD_SITE_URL || process.env.SITE_URL || process.env.VITE_SITE_URL || DEFAULT_SITE_URL;

app.use(express.json({
  limit: "50gb",
  verify: (req: any, _res, buf) => {
    req.rawBody = buf.toString("utf8");
  }
}));
app.use(express.urlencoded({ extended: true, limit: "50gb" }));
app.use(cors());
app.use((req, res, next) => {
  if (req.hostname === "localhost" || req.hostname === "127.0.0.1") {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});

import apiRoutes from "./src/server/routes/api.js";
app.use("/api", apiRoutes);
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "API route not found" });
});

app.get("/robots.txt", (_req, res) => {
  res.type("text/plain").send([
    "User-agent: *",
    "Allow: /",
    "Disallow: /api/",
    "Disallow: /login",
    "Disallow: /register",
    "Disallow: /dashboard",
    "Disallow: /servers",
    "Disallow: /store",
    "Disallow: /order",
    "Disallow: /checkout",
    "Disallow: /cart",
    "Disallow: /billing",
    "Disallow: /notifications",
    "Disallow: /account",
    "Disallow: /admin",
    "Disallow: /api-keys",
    "Disallow: /nodes",
    `Sitemap: ${absoluteUrl("/sitemap.xml", siteUrl)}`,
    "",
  ].join("\n"));
});

app.get("/sitemap.xml", (_req, res) => {
  const urls = seoRoutes
    .filter((route) => !route.noindex && !isNoindexPath(route.path))
    .map((route) => {
      const loc = absoluteUrl(route.path, siteUrl);
      const priority = route.path === "/" ? "1.0" : route.path.includes("/game-servers/") || route.path.includes("/vps/") || route.path.includes("/vds/") ? "0.7" : "0.8";
      return `  <url><loc>${loc}</loc><changefreq>weekly</changefreq><priority>${priority}</priority></url>`;
    })
    .join("\n");
  res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
});

import { initSFTPServer } from "./src/server/services/sftp.js";

async function ensureOwnerFromEnv() {
  const envUser = process.env.LIXCLOUD_OWNER_USER || process.env.JTG_OWNER_USER;
  const envPass = process.env.LIXCLOUD_OWNER_PASS || process.env.JTG_OWNER_PASS;
  if (!envUser || !envPass) return;

  try {
    const usersFile = path.join(DATA_DIR, "users.json");
    const users = (await fs.pathExists(usersFile)) ? await fs.readJson(usersFile) : [];
    const existingIndex = users.findIndex(
      (u: any) => u.username && u.username.toLowerCase() === envUser.toLowerCase()
    );
    const bcrypt = await import("bcryptjs");
    const hashedPassword = await bcrypt.default.hash(envPass, 10);

    if (existingIndex !== -1) {
      users[existingIndex].password = hashedPassword;
      users[existingIndex].role = "owner";
      users[existingIndex].passwordVersion = (users[existingIndex].passwordVersion || 0) + 1;
    } else {
      users.forEach((u: any) => {
        if (u.role === "owner") u.role = "admin";
      });
      users.push({
        id: "owner-" + Date.now() + "-" + Math.random().toString(36).substring(2, 7),
        username: envUser,
        password: hashedPassword,
        role: "owner",
        passwordVersion: 0,
        createdAt: new Date().toISOString(),
      });
    }
    await fs.writeJson(usersFile, users, { spaces: 2 });
    console.log(`[ZyntixCloud] Owner user '${envUser}' ensured in database.`);
  } catch (err) {
    console.error("[ZyntixCloud] Failed to ensure owner from environment:", err);
  }
}

async function startServer() {
  await ensureOwnerFromEnv();
  await initSFTPServer();

  if (isDev) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath, { index: false }));
    app.get("*", (req, res) => {
      const pathname = canonicalPath(req.path);
      const route = getSeoRoute(pathname, siteUrl);
      const statusCode = route.title.startsWith("Page Not Found") ? 404 : 200;
      const indexHtml = fs.readFileSync(path.join(distPath, "index.html"), "utf8");
      res.status(statusCode).type("html").send(injectSeo(indexHtml, route));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`ZyntixCloud Panel running on port ${PORT}`);
  });
}

startServer();

function injectSeo(html: string, route: ReturnType<typeof getSeoRoute>) {
  const tags = renderMetaTags(route, siteUrl);
  return html
    .replace(/<title>[\s\S]*?<\/title>/i, "")
    .replace(/<meta\s+name=["']description["'][^>]*>\s*/i, "")
    .replace('<div id="root"></div>', `<div id="root">${renderSeoBody(route)}</div>`)
    .replace("</head>", `    ${tags}\n  </head>`);
}

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
  fs.writeFileSync('crash.log', String(err.stack));
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION:', reason);
  fs.writeFileSync('crash.log', String(reason));
});

