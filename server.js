const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const UPLOAD_DIR = path.join(ROOT, "uploads");
const STORE_FILE = path.join(DATA_DIR, "store.json");
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const OAUTH_TTL = 10 * 60 * 1000;
const COOKIE_NAME = "gnay_session";
const pendingOAuth = new Map();
const uploadParts = new Map();
const discordPresenceCache = new Map();
const mimeTypes = {
  ".aac": "audio/aac",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".flac": "audio/flac",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
  ".webp": "image/webp",
  ".weba": "audio/webm",
};

function loadEnvFile() {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  }
}

loadEnvFile();
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8765);
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function readStore() {
  try {
    const store = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    return {
      users: store.users || {},
      profiles: store.profiles || {},
      sessions: store.sessions || {},
    };
  } catch (error) {
    if (error.code === "ENOENT") return { users: {}, profiles: {}, sessions: {} };
    throw error;
  }
}

let store = readStore();
function saveStore() {
  const tempFile = STORE_FILE + ".tmp";
  fs.writeFileSync(tempFile, JSON.stringify(store), { mode: 0o600 });
  fs.renameSync(tempFile, STORE_FILE);
}

function sendJson(res, status, value, headers = {}) {
  res.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(JSON.stringify(value));
}

function redirect(res, location, cookie) {
  const headers = { location, "cache-control": "no-store" };
  if (cookie) headers["set-cookie"] = cookie;
  res.writeHead(302, headers);
  res.end();
}

function cookieValue(req, name) {
  const cookies = (req.headers.cookie || "").split(";");
  for (const cookie of cookies) {
    const index = cookie.indexOf("=");
    if (index >= 0 && cookie.slice(0, index).trim() === name) {
      return decodeURIComponent(cookie.slice(index + 1).trim());
    }
  }
  return "";
}

function sessionCookie(value, maxAge) {
  return (
    COOKIE_NAME +
    "=" +
    encodeURIComponent(value) +
    "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" +
    maxAge
  );
}

function tokenHash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function currentUser(req) {
  const sid = cookieValue(req, COOKIE_NAME);
  if (!sid) return null;
  const key = tokenHash(sid);
  const session = store.sessions[key];
  if (!session) return null;
  if (session.expires < Date.now()) {
    delete store.sessions[key];
    saveStore();
    return null;
  }
  const user = store.users[session.slug];
  return user ? { sid, key, user } : null;
}

function requireUser(req, res) {
  const session = currentUser(req);
  if (!session) {
    sendJson(res, 401, { error: "Entre com o Discord para continuar." });
    return null;
  }
  const requestedAccount = req.headers["x-account"];
  if (requestedAccount && requestedAccount !== session.user.slug) {
    sendJson(res, 409, { error: "A conta ativa mudou." });
    return null;
  }
  return session;
}

function checkOrigin(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers.host;
  try {
    const parsedOrigin = new URL(origin);
    if (parsedOrigin.host === host) return true;
    if (process.env.GNAY_SITE_ORIGIN && parsedOrigin.origin === new URL(process.env.GNAY_SITE_ORIGIN).origin) {
      return true;
    }
  } catch {}
  sendJson(res, 403, { error: "Origem não permitida." });
  return false;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("Corpo muito grande."), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req, limit = 2 * 1024 * 1024) {
  const body = await readBody(req, limit);
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw Object.assign(new Error("JSON inválido."), { status: 400 });
  }
}

function cleanProfile(value, depth = 0) {
  if (depth > 20) throw Object.assign(new Error("Perfil muito complexo."), { status: 400 });
  if (Array.isArray(value)) return value.map((item) => cleanProfile(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    result[key] = cleanProfile(item, depth + 1);
  }
  return result;
}

function slugBase(value) {
  const slug = String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20);
  return slug.length >= 3 ? slug : "";
}

function makeSlug(preferred, discordUser) {
  const base = slugBase(preferred) || slugBase(discordUser.global_name) || slugBase(discordUser.username) || "user";
  const existing = store.users[base];
  if (!existing || existing.discordId === discordUser.id) return base;
  const suffix = discordUser.id.slice(-5);
  const candidate = base.slice(0, 14) + "-" + suffix;
  if (!store.users[candidate] || store.users[candidate].discordId === discordUser.id) return candidate;
  return "user-" + discordUser.id.slice(-10);
}

function publicUser(user) {
  const { discordId, ...safeUser } = user;
  return Object.assign(safeUser, { dcId: discordId });
}

async function saveUpload(body, mime) {
  const extension = Object.entries(mimeTypes).find(([, value]) => value === mime)?.[0];
  if (!extension || !/^(image\/|audio\/)/.test(mime)) {
    throw Object.assign(new Error("Formato de arquivo não aceito."), { status: 415 });
  }
  if (!body.length) throw Object.assign(new Error("Arquivo vazio."), { status: 400 });
  const filename = crypto.randomUUID() + extension;
  await fs.promises.writeFile(path.join(UPLOAD_DIR, filename), body, { flag: "wx" });
  return "/uploads/" + filename;
}

async function handleOAuth(req, res, url) {
  const clientId = process.env.DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  const redirectUri = process.env.DISCORD_REDIRECT_URI || "http://localhost:8765/auth/discord/callback";
  if (!clientId || !clientSecret) {
    redirect(res, "/?e=config");
    return;
  }

  const state = crypto.randomBytes(32).toString("hex");
  const pre = url.searchParams.get("pre") || "";
  const add = url.searchParams.get("add") === "1";
  pendingOAuth.set(state, { pre, add, expires: Date.now() + OAUTH_TTL });
  const authorization = new URL("https://discord.com/oauth2/authorize");
  authorization.searchParams.set("client_id", clientId);
  authorization.searchParams.set("redirect_uri", redirectUri);
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("scope", "identify");
  authorization.searchParams.set("state", state);
  redirect(
    res,
    authorization.toString(),
    "gnay_oauth=" +
      state +
      "; Path=/; HttpOnly; SameSite=Lax; Max-Age=600" +
      (redirectUri.startsWith("https://") ? "; Secure" : ""),
  );
}

async function handleOAuthCallback(req, res, url) {
  const state = url.searchParams.get("state") || "";
  const savedState = cookieValue(req, "gnay_oauth");
  const pending = pendingOAuth.get(state);
  pendingOAuth.delete(state);
  const clearState = "gnay_oauth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
  if (!state || state !== savedState || !pending || pending.expires < Date.now()) {
    redirect(res, "/?e=state", clearState);
    return;
  }
  if (url.searchParams.has("error")) {
    redirect(res, "/?e=denied", clearState);
    return;
  }
  const code = url.searchParams.get("code");
  if (!code) {
    redirect(res, "/?e=discord", clearState);
    return;
  }

  try {
    const redirectUri = process.env.DISCORD_REDIRECT_URI || "http://localhost:8765/auth/discord/callback";
    const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
    });
    if (!tokenResponse.ok) throw new Error("Discord token exchange failed: " + tokenResponse.status);
    const token = await tokenResponse.json();
    const identityResponse = await fetch("https://discord.com/api/users/@me", {
      headers: { authorization: "Bearer " + token.access_token },
    });
    if (!identityResponse.ok) throw new Error("Discord identity lookup failed: " + identityResponse.status);
    const identity = await identityResponse.json();
    if (!identity.id || !identity.username) throw new Error("Discord returned an invalid identity.");
    const decorationAsset =
      typeof identity.avatar_decoration_data?.asset === "string" &&
      /^[A-Za-z0-9_]{8,80}$/.test(identity.avatar_decoration_data.asset)
        ? identity.avatar_decoration_data.asset
        : "";

    let user = Object.values(store.users).find((entry) => entry.discordId === identity.id);
    if (!user) {
      const slug = makeSlug(pending.pre, identity);
      user = {
        slug,
        discordId: identity.id,
        du: identity.username,
        dn: identity.global_name || identity.username,
        dav: identity.avatar
          ? "https://cdn.discordapp.com/avatars/" + identity.id + "/" + identity.avatar + ".png?size=256"
          : "",
        decorationAsset,
        uid: Object.keys(store.users).length + 1,
        joined: new Date().toISOString(),
        premium: false,
        host: false,
      };
      store.users[slug] = user;
      store.profiles[slug] = {};
    } else {
      user.du = identity.username;
      user.dn = identity.global_name || identity.username;
      user.dav = identity.avatar
        ? "https://cdn.discordapp.com/avatars/" + identity.id + "/" + identity.avatar + ".png?size=256"
        : "";
      user.decorationAsset = decorationAsset;
    }
    const sid = crypto.randomBytes(32).toString("base64url");
    store.sessions[tokenHash(sid)] = { slug: user.slug, expires: Date.now() + SESSION_TTL };
    saveStore();
    const secure = redirectUri.startsWith("https://") ? "; Secure" : "";
    redirect(
      res,
      "/#painel",
      [clearState, sessionCookie(sid, Math.floor(SESSION_TTL / 1000)) + secure],
    );
  } catch (error) {
    console.error("Discord OAuth callback failed:", error.message);
    redirect(res, "/?e=discord", clearState);
  }
}

async function handleApi(req, res, url) {
  const { pathname } = url;
  if (req.method === "GET" && pathname === "/api/stats") {
    sendJson(res, 200, { views: 0, users: 0, uploads: 0, subs: 0 });
    return;
  }

  const presenceMatch = pathname.match(/^\/api\/discord\/(\d{17,20})$/);
  if (req.method === "GET" && presenceMatch) {
    const id = presenceMatch[1];
    const cached = discordPresenceCache.get(id);
    if (cached && cached.expires > Date.now()) {
      sendJson(res, cached.status, cached.body);
      return;
    }
    let response;
    try {
      response = await fetch("https://api.lanyard.rest/v1/users/" + id, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      throw Object.assign(new Error("Não foi possível consultar a presença do Discord."), {
        status: error.name === "TimeoutError" ? 504 : 502,
      });
    }
    let body;
    try {
      body = await response.json();
    } catch {
      throw Object.assign(new Error("Resposta inválida do serviço de presença do Discord."), { status: 502 });
    }
    const status = response.status === 404 ? 404 : response.ok ? 200 : 502;
    if (discordPresenceCache.size >= 500) {
      discordPresenceCache.delete(discordPresenceCache.keys().next().value);
    }
    const cacheDuration = status === 200 || status === 404 ? 5000 : 15000;
    discordPresenceCache.set(id, { status, body, expires: Date.now() + cacheDuration });
    sendJson(res, status, body);
    return;
  }

  if (req.method === "GET" && pathname === "/api/me") {
    const session = currentUser(req);
    if (!session) {
      sendJson(res, 200, { user: null, profile: {} });
      return;
    }
    const profile = Object.assign({}, store.profiles[session.user.slug] || {}, {
      dcId: session.user.discordId,
    });
    sendJson(res, 200, {
      user: publicUser(session.user),
      profile,
    });
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/api/page/")) {
    const slug = decodeURIComponent(pathname.slice("/api/page/".length));
    const user = store.users[slug];
    if (!user) {
      sendJson(res, 404, { error: "Página não encontrada." });
      return;
    }
    const profile = Object.assign({}, store.profiles[slug] || {}, {
      dcId: user.discordId,
    });
    sendJson(res, 200, {
      slug,
      profile,
      meta: publicUser(user),
    });
    return;
  }

  const session = requireUser(req, res);
  if (!session) return;

  if (req.method === "PUT" && pathname === "/api/profile") {
    if (!checkOrigin(req, res)) return;
    const body = await readJson(req);
    if (!body.profile || typeof body.profile !== "object" || Array.isArray(body.profile)) {
      sendJson(res, 400, { error: "Perfil inválido." });
      return;
    }
    const profile = cleanProfile(body.profile);
    profile.dcId = session.user.discordId;
    store.profiles[session.user.slug] = profile;
    saveStore();
    sendJson(res, 200, { profile: store.profiles[session.user.slug] });
    return;
  }

  if (req.method === "POST" && pathname === "/api/upload") {
    if (!checkOrigin(req, res)) return;
    const mime = (req.headers["content-type"] || "").split(";")[0].toLowerCase();
    const body = await readBody(req, 25 * 1024 * 1024);
    sendJson(res, 200, { url: await saveUpload(body, mime) });
    return;
  }

  if (req.method === "POST" && pathname === "/api/upload/part") {
    if (!checkOrigin(req, res)) return;
    const id = url.searchParams.get("id") || "";
    const index = Number(url.searchParams.get("i"));
    const count = Number(url.searchParams.get("n"));
    if (!/^[a-f0-9]{32}$/i.test(id) || !Number.isInteger(index) || !Number.isInteger(count) || count < 1 || count > 50 || index < 0 || index >= count) {
      sendJson(res, 400, { error: "Parte de upload inválida." });
      return;
    }
    const now = Date.now();
    for (const [key, upload] of uploadParts) {
      if (now - upload.updated > 30 * 60 * 1000) uploadParts.delete(key);
    }
    let upload = uploadParts.get(id);
    if (!upload) {
      const active = [...uploadParts.values()].filter((item) => item.slug === session.user.slug).length;
      if (active >= 8) {
        sendJson(res, 429, { error: "Muitos uploads em andamento." });
        return;
      }
      upload = { slug: session.user.slug, count, chunks: new Array(count), updated: now };
      uploadParts.set(id, upload);
    }
    if (upload.slug !== session.user.slug || upload.count !== count) {
      sendJson(res, 400, { error: "Upload inválido." });
      return;
    }
    const chunk = await readBody(req, 512 * 1024);
    upload.chunks[index] = chunk;
    upload.updated = now;
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && pathname === "/api/upload/done") {
    if (!checkOrigin(req, res)) return;
    const body = await readJson(req, 16 * 1024);
    const upload = uploadParts.get(body.id);
    if (
      !upload ||
      upload.slug !== session.user.slug ||
      upload.count !== body.n ||
      upload.chunks.some((chunk) => !chunk)
    ) {
      sendJson(res, 400, { error: "Upload incompleto ou expirado." });
      return;
    }
    const bytes = Buffer.concat(upload.chunks);
    if (bytes.length > 25 * 1024 * 1024) {
      uploadParts.delete(body.id);
      sendJson(res, 413, { error: "Arquivo maior que 25 MB." });
      return;
    }
    uploadParts.delete(body.id);
    sendJson(res, 200, { url: await saveUpload(bytes, String(body.mime || "").toLowerCase()) });
    return;
  }

  if (req.method === "POST" && pathname === "/api/logout") {
    if (!checkOrigin(req, res)) return;
    delete store.sessions[session.key];
    saveStore();
    sendJson(res, 200, { ok: true }, { "set-cookie": sessionCookie("", 0) });
    return;
  }

  if (req.method === "GET" && pathname === "/api/accounts") {
    sendJson(res, 200, {
      accounts: [{ slug: session.user.slug, du: session.user.du, dn: session.user.dn, dav: session.user.dav, current: true }],
    });
    return;
  }

  if (req.method === "DELETE" && pathname === "/api/account") {
    if (!checkOrigin(req, res)) return;
    delete store.users[session.user.slug];
    delete store.profiles[session.user.slug];
    delete store.sessions[session.key];
    saveStore();
    sendJson(res, 200, { ok: true }, { "set-cookie": sessionCookie("", 0) });
    return;
  }

  sendJson(res, 501, { error: "Este recurso ainda precisa do backend oficial." });
}

async function serveStatic(req, res, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendJson(res, 400, { error: "Caminho inválido." });
    return;
  }
  const uploadName = decoded.startsWith("/uploads/") ? decoded.slice("/uploads/".length) : "";
  const isAllowedUpload = !!uploadName && path.basename(uploadName) === uploadName;
  const isPublicFile = ["/", "/index.html", "/hero-bg.jpg", "/shooting-banner.jpg"].includes(decoded);
  if (!isAllowedUpload && !isPublicFile) {
    sendJson(res, 404, { error: "Arquivo não encontrado." });
    return;
  }
  const relative = isAllowedUpload ? path.join("uploads", uploadName) : decoded === "/" ? "index.html" : decoded.slice(1);
  const file = path.resolve(ROOT, relative);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    sendJson(res, 403, { error: "Caminho não permitido." });
    return;
  }
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) throw Object.assign(new Error("Not a file"), { code: "ENOENT" });
    res.writeHead(200, {
      "cache-control": file.endsWith("index.html") ? "no-cache" : "public, max-age=3600",
      "content-length": stat.size,
      "content-type": mimeTypes[path.extname(file).toLowerCase()] || "application/octet-stream",
      "x-content-type-options": "nosniff",
    });
    fs.createReadStream(file).pipe(res);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendJson(res, 404, { error: "Arquivo não encontrado." });
      return;
    }
    throw error;
  }
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
    if (url.pathname === "/healthz" && req.method === "GET") {
      sendJson(res, 200, { status: "ok" });
    } else if (url.pathname === "/auth/discord" && req.method === "GET") {
      await handleOAuth(req, res, url);
    } else if (url.pathname === "/auth/discord/callback" && req.method === "GET") {
      await handleOAuthCallback(req, res, url);
    } else if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
    } else {
      await serveStatic(req, res, url.pathname);
    }
  } catch (error) {
    if (!res.headersSent) sendJson(res, error.status || 500, { error: error.message || "Erro interno." });
    else res.destroy(error);
    if (!error.status) console.error("Request failed:", error);
  }
});

server.listen(PORT, HOST, () => {
  console.log("gnay local server: http://" + HOST + ":" + PORT);
  if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET) {
    console.log("Discord OAuth is not configured. Set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET in .env.");
  }
});
