const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");

const ROOT = __dirname;
const DATA_DIR = process.env.GNAY_DATA_DIR || path.join(ROOT, "data");
const UPLOAD_DIR = process.env.GNAY_UPLOAD_DIR || path.join(ROOT, "uploads");
const UPLOAD_PART_DIR = path.join(UPLOAD_DIR, ".parts");
const CHAT_AUDIO_DIR = path.join(DATA_DIR, "chat-audio");
const STORE_FILE = path.join(DATA_DIR, "store.json");
const UPLOAD_CHUNK_SIZE = 512 * 1024;
const MAX_UPLOAD_SIZE = 1024 * 1024 * 1024;
const MAX_UPLOAD_PARTS = Math.ceil(MAX_UPLOAD_SIZE / UPLOAD_CHUNK_SIZE);
const MAX_TEMPLATE_PROFILE_SIZE = 512 * 1024;
const MAX_PROFILE_TEMPLATE_SIZE = 1536 * 1024;
const MAX_CHAT_AUDIO_SIZE = 10 * 1024 * 1024;
const CHAT_MESSAGE_LIMIT = 100;
const CHAT_GUILD_ID = "1558728880309665845";
const CHAT_MEMBER_ROLE_ID = "1558728880628441135";
const CHAT_ADMIN_ROLE_IDS = new Set([
  "1558728880695681106",
  "1559579048609583136",
  "1560406584998236160",
  "1558728880683089999",
]);
const TEMPLATE_LIMIT = 10;
const PROFILE_TEMPLATE_LIMIT = 50;
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const OAUTH_TTL = 10 * 60 * 1000;
const COOKIE_NAME = "gnay_session";
const RESERVED_SLUGS = new Set([
  "admin",
  "api",
  "badges",
  "chat",
  "conexoes",
  "config",
  "customizacao",
  "faq",
  "help",
  "home",
  "layout",
  "links",
  "login",
  "logimcomgnay",
  "logincomshooting",
  "modelo",
  "modelos",
  "painel",
  "personalizar",
  "perfil",
  "precos",
  "recursos",
  "shooting",
  "staff",
  "estatisticas",
]);
const uploadParts = new Map();
const chatPostTimes = new Map();
const friendRequestTimes = new Map();
const discordPresenceCache = new Map();
const discordMemberRoleCache = new Map();
const discordMemberRolePending = new Map();
const audioInfoCache = new Map();
const CHAT_STICKERS = Object.freeze({
  wave: { emoji: "👋", name: "Oi" },
  heart: { emoji: "💖", name: "Coração" },
  star: { emoji: "🌟", name: "Estrela" },
  party: { emoji: "🎉", name: "Comemoração" },
  cat: { emoji: "😺", name: "Gatinho" },
  fire: { emoji: "🔥", name: "Fogo" },
  moon: { emoji: "🌙", name: "Lua" },
  sparkle: { emoji: "✨", name: "Brilho" },
});
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
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".ogv": "video/ogg",
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
fs.mkdirSync(UPLOAD_PART_DIR, { recursive: true });
fs.mkdirSync(CHAT_AUDIO_DIR, { recursive: true });
for (const name of fs.readdirSync(UPLOAD_PART_DIR)) {
  if (/^[a-f0-9]{32}\.part$/i.test(name)) fs.rmSync(path.join(UPLOAD_PART_DIR, name), { force: true });
}

function readStore() {
  try {
    const store = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    return {
      users: store.users || {},
      profiles: store.profiles || {},
      profileTemplates: store.profileTemplates || {},
      sessions: store.sessions || {},
      templates: store.templates || {},
      chatMessages: Array.isArray(store.chatMessages) ? store.chatMessages : [],
      chatFriendRequests: Array.isArray(store.chatFriendRequests) ? store.chatFriendRequests : [],
      chatFriendships: Array.isArray(store.chatFriendships) ? store.chatFriendships : [],
      chatDmMessages: Array.isArray(store.chatDmMessages) ? store.chatDmMessages : [],
      templateFavorites: store.templateFavorites || {},
      templateRecent: store.templateRecent || {},
      viewedIps: store.viewedIps || {},
      viewHashSecret: store.viewHashSecret,
    };
  } catch (error) {
    if (error.code === "ENOENT")
      return {
        users: {},
        profiles: {},
        profileTemplates: {},
        sessions: {},
        templates: {},
        chatMessages: [],
        chatFriendRequests: [],
        chatFriendships: [],
        chatDmMessages: [],
        templateFavorites: {},
        templateRecent: {},
        viewedIps: {},
      };
    throw error;
  }
}

let store = readStore();
if (typeof store.viewHashSecret !== "string" || store.viewHashSecret.length < 32) {
  store.viewHashSecret = crypto.randomBytes(32).toString("hex");
  saveStore();
}
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

function clientIp(req) {
  const forwarded = typeof req.headers["x-forwarded-for"] === "string" ? req.headers["x-forwarded-for"].split(",")[0] : "";
  const candidates = [
    req.headers["x-nf-client-connection-ip"],
    req.headers["cf-connecting-ip"],
    req.headers["x-real-ip"],
    forwarded,
    req.socket.remoteAddress,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    let address = candidate.trim();
    if (address.startsWith("[") && address.includes("]")) address = address.slice(1, address.indexOf("]"));
    if (net.isIP(address)) {
      if (address.startsWith("::ffff:") && net.isIP(address.slice(7)) === 4) address = address.slice(7);
      return address.toLowerCase();
    }
  }
  return "";
}

function isLoopback(req) {
  let address = req.socket.remoteAddress || "";
  if (address.startsWith("::ffff:")) address = address.slice(7);
  return address === "127.0.0.1" || address === "::1";
}

function allowChatPost(userId) {
  const now = Date.now();
  const last = chatPostTimes.get(userId) || 0;
  if (now - last < 1500) return false;
  chatPostTimes.set(userId, now);
  if (chatPostTimes.size > 2000) {
    for (const [id, timestamp] of chatPostTimes) {
      if (now - timestamp > 60_000) chatPostTimes.delete(id);
    }
  }
  return true;
}

function allowFriendRequest(userId) {
  const now = Date.now();
  const last = friendRequestTimes.get(userId) || 0;
  if (now - last < 10_000) return false;
  friendRequestTimes.set(userId, now);
  return true;
}

function trimChatMessages() {
  const removed = store.chatMessages.splice(0, Math.max(0, store.chatMessages.length - CHAT_MESSAGE_LIMIT));
  for (const message of removed) {
    if (!message.audio || store.chatMessages.some((entry) => entry.audio === message.audio)) continue;
    fs.promises.unlink(path.join(CHAT_AUDIO_DIR, message.audio + ".audio")).catch((error) => {
      if (error.code !== "ENOENT") console.error("Could not remove expired chat audio:", error);
    });
  }
}

function deleteChatMessagesBySlug(slug) {
  const removed = store.chatMessages.filter((message) => message.slug === slug);
  store.chatMessages = store.chatMessages.filter((message) => message.slug !== slug);
  for (const message of removed) {
    if (!message.audio || store.chatMessages.some((entry) => entry.audio === message.audio)) continue;
    fs.promises.unlink(path.join(CHAT_AUDIO_DIR, message.audio + ".audio")).catch((error) => {
      if (error.code !== "ENOENT") console.error("Could not remove deleted user's chat audio:", error);
    });
  }
}

function chatUserCard(discordId) {
  const user = Object.values(store.users).find((entry) => entry.discordId === discordId);
  if (!user) return null;
  const profile = store.profiles[user.slug] || {};
  const rawAvatar = profile.avatar || user.dav || "";
  const avatar =
    typeof rawAvatar === "string" &&
    rawAvatar.length <= 4096 &&
    /^(https:\/\/|\/uploads\/|data:image\/(?:png|jpeg|webp|gif);base64,)/i.test(rawAvatar)
      ? rawAvatar
      : "";
  return {
    slug: user.slug,
    name: String(profile.dn || user.dn || user.du || "Usuário").slice(0, 40),
    avatar,
  };
}

function chatFriendshipFor(id, discordId) {
  if (!/^[a-f0-9-]{36}$/i.test(id)) return null;
  const friendship = store.chatFriendships.find(
    (entry) => entry.id === id && (entry.a === discordId || entry.b === discordId),
  );
  return friendship || null;
}

async function chatMemberRole(discordId) {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!botToken || !/^\d{17,20}$/.test(discordId || "")) return "";
  const cached = discordMemberRoleCache.get(discordId);
  if (cached && cached.expiresAt > Date.now()) return cached.role;
  const pending = discordMemberRolePending.get(discordId);
  if (pending) return pending;
  const lookup = (async () => {
    try {
      const response = await fetch(
        "https://discord.com/api/v10/guilds/" + CHAT_GUILD_ID + "/members/" + encodeURIComponent(discordId),
        { headers: { authorization: "Bot " + botToken } },
      );
      if (response.status === 404) {
        discordMemberRoleCache.set(discordId, { role: "", expiresAt: Date.now() + 5 * 60_000 });
        return "";
      }
      if (!response.ok) {
        discordMemberRoleCache.set(discordId, { role: "", expiresAt: Date.now() + 30_000 });
        console.error("Discord guild role lookup failed with HTTP " + response.status + ".");
        return "";
      }
      const member = await response.json();
      const roles = Array.isArray(member.roles) ? member.roles : [];
      const role = roles.some((id) => CHAT_ADMIN_ROLE_IDS.has(id))
        ? "admin"
        : roles.includes(CHAT_MEMBER_ROLE_ID)
          ? "member"
          : "";
      discordMemberRoleCache.set(discordId, { role, expiresAt: Date.now() + 5 * 60_000 });
      return role;
    } catch (error) {
      discordMemberRoleCache.set(discordId, { role: "", expiresAt: Date.now() + 30_000 });
      console.error("Discord guild role lookup failed:", error.message);
      return "";
    } finally {
      discordMemberRolePending.delete(discordId);
    }
  })();
  discordMemberRolePending.set(discordId, lookup);
  return lookup;
}

function viewIpHash(slug, address) {
  return crypto.createHmac("sha256", store.viewHashSecret).update(slug + "\0" + address).digest("hex");
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
  return slug.length >= 2 ? slug : "";
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

function templateOwnedBy(template, user) {
  return !!template && !!user && template.ownerId === user.discordId;
}

function templateAccessible(template, user) {
  return !!template && (template.vis !== "private" || templateOwnedBy(template, user));
}

function templateProfileSnapshot(profile) {
  const snapshot = cleanProfile(profile);
  ["dcId", "dcPremiumType", "views", "vd", "dv", "src", "clicks", "cd", "nc", "ctry"].forEach((key) =>
    delete snapshot[key],
  );
  return snapshot;
}

function applyTemplateBioStyles(profileBio, templateBio) {
  const bio = typeof profileBio === "string" ? profileBio : "";
  if (!bio) return bio;

  const tagPattern = /\[(\/?)(b|i|u|s|glow|rainbow|shake|c(?:=#[0-9a-fA-F]{3,8})?|rgb(?:=#[0-9a-fA-F]{6},#[0-9a-fA-F]{6})?)\]/g;
  const stack = [];
  const matched = [];
  let match;
  while ((match = tagPattern.exec(String(templateBio || ""))) !== null) {
    const tag = match[2].split("=")[0];
    if (match[1]) {
      if (stack.length && stack[stack.length - 1].tag === tag) matched.push(stack.pop());
    } else if (tag !== "c" || match[2].includes("=")) {
      stack.push({ tag, token: match[0], index: match.index });
    }
  }

  const effectGroup = (tag) => (tag === "c" || tag === "rgb" || tag === "rainbow" ? "color" : tag);
  const styles = new Map();
  matched
    .sort((a, b) => a.index - b.index)
    .forEach((style) => styles.set(effectGroup(style.tag), style));
  const wrappers = [...styles.values()];
  if (!wrappers.length) return bio;
  const overriddenEffects = new Set(styles.keys());
  const bioWithTemplateEffects = bio.replace(tagPattern, (token, _closing, content) =>
    overriddenEffects.has(effectGroup(content.split("=")[0])) ? "" : token,
  );

  return (
    wrappers.map((style) => style.token).join("") +
    bioWithTemplateEffects +
    wrappers
      .slice()
      .reverse()
      .map((style) => "[/" + style.tag + "]")
      .join("")
  );
}

function templateStars(id) {
  return Object.values(store.templateFavorites).reduce(
    (total, favorites) => total + (Array.isArray(favorites) && favorites.includes(id) ? 1 : 0),
    0,
  );
}

function publicTemplate(template, user, includeProfile = false) {
  const owned = templateOwnedBy(template, user);
  const favorites = user ? store.templateFavorites[user.discordId] || [] : [];
  const result = {
    id: template.id,
    name: template.name,
    tags: template.tags,
    vis: template.vis,
    preview: template.preview,
    audio: template.audio,
    owner: { slug: template.ownerSlug, dn: template.ownerName },
    created: template.created,
    uses: template.uses,
    stars: templateStars(template.id),
    fav: favorites.includes(template.id),
    mine: owned,
    premium: !!template.premium,
  };
  if (includeProfile) result.profile = template.profile;
  return result;
}

function cleanTemplateFields(body, current) {
  const name =
    body.name === undefined
      ? current && current.name
      : typeof body.name === "string"
        ? body.name.trim().slice(0, 40)
        : "";
  if (!name) throw Object.assign(new Error("Nome de template inválido."), { status: 400 });
  const tags = body.tags === undefined ? (current && current.tags) || [] : body.tags;
  if (
    !Array.isArray(tags) ||
    tags.length > 5 ||
    tags.some((tag) => typeof tag !== "string" || !tag.trim() || tag.trim().length > 20)
  ) {
    throw Object.assign(new Error("Tags inválidas."), { status: 400 });
  }
  const vis = body.vis === undefined ? (current && current.vis) || "public" : body.vis;
  if (!["public", "unlisted", "private"].includes(vis)) {
    throw Object.assign(new Error("Visibilidade inválida."), { status: 400 });
  }
  const preview = body.preview === undefined ? (current && current.preview) || "" : body.preview;
  const audio = body.audio === undefined ? (current && current.audio) || "" : body.audio;
  for (const [value, label] of [[preview, "Imagem de prévia"], [audio, "Áudio"]]) {
    let validUrl = value === "";
    if (typeof value === "string" && value.length <= 2048 && /^\/uploads\/[a-f0-9-]{36}\.[a-z0-9]+$/i.test(value)) {
      validUrl = true;
    } else if (typeof value === "string" && value.length <= 2048 && /^https:\/\//i.test(value)) {
      try {
        const parsed = new URL(value);
        validUrl = !parsed.username && !parsed.password;
      } catch {}
    }
    if (!validUrl) {
      throw Object.assign(new Error(label + " inválido."), { status: 400 });
    }
  }
  const profile = body.profile === undefined ? current && current.profile : body.profile;
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw Object.assign(new Error("Perfil do template inválido."), { status: 400 });
  }
  const cleanProfileValue = templateProfileSnapshot(profile);
  if (Buffer.byteLength(JSON.stringify(cleanProfileValue), "utf8") > MAX_TEMPLATE_PROFILE_SIZE) {
    throw Object.assign(new Error("too_large"), { status: 413 });
  }
  return {
    name,
    tags: [...new Set(tags.map((tag) => tag.trim()))],
    vis,
    preview,
    audio,
    profile: cleanProfileValue,
  };
}

function uploadExtension(mime) {
  const extension = Object.entries(mimeTypes).find(([, value]) => value === mime)?.[0];
  if (!extension || !/^(image\/|audio\/|video\/)/.test(mime)) {
    throw Object.assign(new Error("Formato de arquivo não aceito."), { status: 415 });
  }
  return extension;
}

async function saveUpload(body, mime) {
  const extension = uploadExtension(mime);
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
  const pending = Buffer.from(
    JSON.stringify({
      state,
      pre: (url.searchParams.get("pre") || "").slice(0, 40),
      expires: Date.now() + OAUTH_TTL,
    }),
  ).toString("base64url");
  const signature = crypto.createHmac("sha256", clientSecret).update(pending).digest("base64url");
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
      pending +
      "." +
      signature +
      "; Path=/; HttpOnly; SameSite=Lax; Max-Age=600" +
      (redirectUri.startsWith("https://") ? "; Secure" : ""),
  );
}

async function handleOAuthCallback(req, res, url) {
  const state = url.searchParams.get("state") || "";
  const savedState = cookieValue(req, "gnay_oauth");
  const clearState = "gnay_oauth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  if (!process.env.DISCORD_CLIENT_ID || !clientSecret) {
    redirect(res, "/?e=config", clearState);
    return;
  }
  const [encodedPending, encodedSignature, extra] = savedState.split(".");
  let pending = null;
  if (encodedPending && encodedSignature && extra === undefined) {
    const expectedSignature = crypto.createHmac("sha256", clientSecret).update(encodedPending).digest();
    const receivedSignature = Buffer.from(encodedSignature, "base64url");
    if (
      receivedSignature.length === expectedSignature.length &&
      crypto.timingSafeEqual(receivedSignature, expectedSignature)
    ) {
      try {
        pending = JSON.parse(Buffer.from(encodedPending, "base64url").toString("utf8"));
      } catch {}
    }
  }
  if (
    !state ||
    !pending ||
    pending.state !== state ||
    !Number.isSafeInteger(pending.expires) ||
    pending.expires < Date.now()
  ) {
    redirect(res, "/?e=state", clearState);
    return;
  }
  if (url.searchParams.has("error")) {
    const error = url.searchParams.get("error");
    console.warn("Discord OAuth authorization returned:", error);
    redirect(
      res,
      error === "access_denied" ? "/?e=denied" : error === "invalid_scope" ? "/?e=scope" : "/?e=discord",
      clearState,
    );
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
      store.users[user.slug] = user;
      store.profiles[user.slug] = {};
    } else {
      user.du = identity.username;
      user.dn = identity.global_name || identity.username;
      user.dav = identity.avatar
        ? "https://cdn.discordapp.com/avatars/" + identity.id + "/" + identity.avatar + ".png?size=256"
        : "";
      user.decorationAsset = decorationAsset;
    }
    user.premiumType =
      Number.isInteger(identity.premium_type) && identity.premium_type >= 0 && identity.premium_type <= 3
        ? identity.premium_type
        : 0;
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
  if (pathname === "/api/local-test/login" && req.method === "POST") {
    if (process.env.GNAY_LOCAL_TEST !== "1" || !isLoopback(req)) {
      sendJson(res, 404, { error: "Endpoint não encontrado." });
      return;
    }
    if (!checkOrigin(req, res)) return;
    const discordId = "999999999999999999";
    let user = Object.values(store.users).find((entry) => entry.discordId === discordId);
    if (!user) {
      user = {
        slug: "localteste",
        discordId,
        du: "local.demo",
        dn: "Visitante de teste",
        dav: "",
        uid: Object.keys(store.users).length + 1,
        joined: new Date().toISOString(),
        premium: false,
        host: false,
        premiumType: 0,
      };
      store.users[user.slug] = user;
      store.profiles[user.slug] = {};
    }
    const sid = crypto.randomBytes(32).toString("base64url");
    store.sessions[tokenHash(sid)] = { slug: user.slug, expires: Date.now() + SESSION_TTL };
    saveStore();
    sendJson(res, 200, { ok: true }, { "set-cookie": sessionCookie(sid, Math.floor(SESSION_TTL / 1000)) });
    return;
  }

  if (pathname === "/api/chat/social" && req.method === "GET") {
    const session = requireUser(req, res);
    if (!session) return;
    const discordId = session.user.discordId;
    const incoming = store.chatFriendRequests
      .filter((request) => request.toId === discordId)
      .map((request) => Object.assign({ id: request.id, created: request.created }, { user: chatUserCard(request.fromId) }))
      .filter((request) => request.user);
    const outgoing = store.chatFriendRequests
      .filter((request) => request.fromId === discordId)
      .map((request) => Object.assign({ id: request.id, created: request.created }, { user: chatUserCard(request.toId) }))
      .filter((request) => request.user);
    const friends = store.chatFriendships
      .filter((friendship) => friendship.a === discordId || friendship.b === discordId)
      .map((friendship) =>
        Object.assign(
          { id: friendship.id, created: friendship.created },
          { user: chatUserCard(friendship.a === discordId ? friendship.b : friendship.a) },
        ),
      )
      .filter((friendship) => friendship.user);
    sendJson(res, 200, { incoming, outgoing, friends });
    return;
  }

  if (pathname === "/api/chat/friends" && req.method === "POST") {
    const session = requireUser(req, res);
    if (!session) return;
    if (!checkOrigin(req, res)) return;
    const body = await readJson(req, 4096);
    const targetSlug = typeof body.slug === "string" ? body.slug.toLowerCase() : "";
    const target = /^[a-z0-9_-]{2,20}$/.test(targetSlug) ? store.users[targetSlug] : null;
    if (!target) {
      sendJson(res, 404, { error: "Perfil não encontrado." });
      return;
    }
    if (target.discordId === session.user.discordId) {
      sendJson(res, 400, { error: "Você não pode enviar um pedido para si mesmo." });
      return;
    }
    if (store.chatFriendships.some((entry) => entry.a === session.user.discordId && entry.b === target.discordId || entry.b === session.user.discordId && entry.a === target.discordId)) {
      sendJson(res, 409, { error: "Vocês já são amigos." });
      return;
    }
    if (store.chatFriendRequests.some((entry) => entry.fromId === target.discordId && entry.toId === session.user.discordId)) {
      sendJson(res, 409, { error: "Essa pessoa já enviou um pedido. Confira seus pedidos recebidos." });
      return;
    }
    if (store.chatFriendRequests.some((entry) => entry.fromId === session.user.discordId && entry.toId === target.discordId)) {
      sendJson(res, 409, { error: "O pedido já foi enviado." });
      return;
    }
    if (!allowFriendRequest(session.user.discordId)) {
      sendJson(res, 429, { error: "Aguarde antes de enviar outro pedido de amizade." });
      return;
    }
    const request = {
      id: crypto.randomUUID(),
      fromId: session.user.discordId,
      toId: target.discordId,
      created: Date.now(),
    };
    store.chatFriendRequests.push(request);
    saveStore();
    sendJson(res, 201, { request: { id: request.id, created: request.created } });
    return;
  }

  const friendResponseMatch = pathname.match(/^\/api\/chat\/friends\/([a-f0-9-]{36})\/respond$/i);
  if (friendResponseMatch && req.method === "POST") {
    const session = requireUser(req, res);
    if (!session) return;
    if (!checkOrigin(req, res)) return;
    const body = await readJson(req, 4096);
    if (body.action !== "accept" && body.action !== "decline") {
      sendJson(res, 400, { error: "Ação de pedido inválida." });
      return;
    }
    const index = store.chatFriendRequests.findIndex(
      (request) => request.id === friendResponseMatch[1] && request.toId === session.user.discordId,
    );
    if (index < 0) {
      sendJson(res, 404, { error: "Pedido de amizade não encontrado." });
      return;
    }
    const request = store.chatFriendRequests[index];
    store.chatFriendRequests.splice(index, 1);
    if (body.action === "accept") {
      const [a, b] = [request.fromId, request.toId].sort();
      if (!store.chatFriendships.some((entry) => entry.a === a && entry.b === b)) {
        store.chatFriendships.push({ id: crypto.randomUUID(), a, b, created: Date.now() });
      }
    }
    saveStore();
    sendJson(res, 200, { ok: true, accepted: body.action === "accept" });
    return;
  }

  const friendMatch = pathname.match(/^\/api\/chat\/friends\/([a-f0-9-]{36})$/i);
  if (friendMatch && req.method === "DELETE") {
    const session = requireUser(req, res);
    if (!session) return;
    if (!checkOrigin(req, res)) return;
    const friendship = chatFriendshipFor(friendMatch[1], session.user.discordId);
    if (!friendship) {
      sendJson(res, 404, { error: "Amizade não encontrada." });
      return;
    }
    store.chatFriendships = store.chatFriendships.filter((entry) => entry.id !== friendship.id);
    store.chatDmMessages = store.chatDmMessages.filter((message) => message.friendshipId !== friendship.id);
    saveStore();
    sendJson(res, 200, { ok: true });
    return;
  }

  const chatDmMatch = pathname.match(/^\/api\/chat\/dm\/([a-f0-9-]{36})$/i);
  if (chatDmMatch && (req.method === "GET" || req.method === "POST")) {
    const session = requireUser(req, res);
    if (!session) return;
    const friendship = chatFriendshipFor(chatDmMatch[1], session.user.discordId);
    if (!friendship) {
      sendJson(res, 403, { error: "A conversa só está disponível entre amigos." });
      return;
    }
    if (req.method === "GET") {
      const messages = store.chatDmMessages
        .filter((message) => message.friendshipId === friendship.id)
        .slice(-100)
        .map((message) => {
          const author = chatUserCard(message.fromId);
          const template = message.templateId ? store.templates[message.templateId] : null;
          return {
            id: message.id,
            fromId: message.fromId,
            created: message.created,
            text: message.text || "",
            sticker: message.sticker || "",
            author,
            template: template && template.vis === "public"
              ? { id: template.id, name: template.name, ownerSlug: template.ownerSlug, preview: template.preview || "" }
              : null,
          };
        })
        .filter((message) => message.author);
      sendJson(res, 200, { messages });
      return;
    }
    if (!checkOrigin(req, res)) return;
    if (!allowChatPost(session.user.discordId)) {
      sendJson(res, 429, { error: "Aguarde um instante antes de enviar outra mensagem." });
      return;
    }
    const body = await readJson(req, 16 * 1024);
    const type = body.type === "sticker" || body.type === "template" ? body.type : "text";
    const message = {
      id: crypto.randomUUID(),
      friendshipId: friendship.id,
      fromId: session.user.discordId,
      toId: friendship.a === session.user.discordId ? friendship.b : friendship.a,
      text: "",
      sticker: "",
      templateId: "",
      created: Date.now(),
    };
    if (type === "text") {
      message.text = typeof body.text === "string" ? body.text.trim() : "";
      if (!message.text || message.text.length > 1000) {
        sendJson(res, 400, { error: "Escreva uma mensagem de até 1000 caracteres." });
        return;
      }
    } else if (type === "sticker") {
      if (typeof body.sticker !== "string" || !Object.hasOwn(CHAT_STICKERS, body.sticker)) {
        sendJson(res, 400, { error: "Figurinha inválida." });
        return;
      }
      message.sticker = body.sticker;
    } else {
      const templateId = typeof body.templateId === "string" ? body.templateId : String(body.templateId || "");
      const template = /^\d{1,9}$/.test(templateId) ? store.templates[templateId] : null;
      if (!template || template.vis !== "public") {
        sendJson(res, 404, { error: "Esse template público não está disponível." });
        return;
      }
      message.templateId = template.id;
    }
    store.chatDmMessages.push(message);
    const dmForFriendship = store.chatDmMessages.filter((entry) => entry.friendshipId === friendship.id);
    if (dmForFriendship.length > 100) {
      const expiredIds = new Set(dmForFriendship.slice(0, dmForFriendship.length - 100).map((entry) => entry.id));
      store.chatDmMessages = store.chatDmMessages.filter((entry) => !expiredIds.has(entry.id));
    }
    saveStore();
    sendJson(res, 201, { message: { id: message.id } });
    return;
  }

  if (pathname === "/api/chat/messages" && (req.method === "GET" || req.method === "POST")) {
    const session = requireUser(req, res);
    if (!session) return;
    if (req.method === "GET") {
      const recentMessages = store.chatMessages.slice(-CHAT_MESSAGE_LIMIT);
      const messages = await Promise.all(recentMessages.map(async (message) => {
        const user = store.users[message.slug];
        const profile = store.profiles[message.slug] || {};
        const rawAvatar = profile.avatar || (user && user.dav) || "";
        const avatar =
          typeof rawAvatar === "string" &&
          rawAvatar.length <= 4096 &&
          /^(https:\/\/|\/uploads\/|data:image\/(?:png|jpeg|webp|gif);base64,)/i.test(rawAvatar)
            ? rawAvatar
            : "";
        return {
          id: message.id,
          text: message.text,
          sticker: message.sticker || "",
          audio: message.audio || "",
          created: message.created,
          author: {
            slug: message.slug,
            name: String(profile.dn || (user && (user.dn || user.du)) || "Usuário").slice(0, 40),
            avatar,
            discordId: user ? user.discordId : "",
            memberRole: user ? await chatMemberRole(user.discordId) : "",
          },
        };
      }));
      sendJson(res, 200, { messages });
      return;
    }
    if (!checkOrigin(req, res)) return;
    if (!allowChatPost(session.user.discordId)) {
      sendJson(res, 429, { error: "Aguarde um instante antes de enviar outra mensagem." });
      return;
    }
    const body = await readJson(req, 16 * 1024);
    const sticker = body.type === "sticker" && typeof body.sticker === "string" ? body.sticker : "";
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (sticker && !Object.hasOwn(CHAT_STICKERS, sticker)) {
      sendJson(res, 400, { error: "Figurinha inválida." });
      return;
    }
    if (!sticker && (!text || text.length > 1000)) {
      sendJson(res, 400, { error: "Escreva uma mensagem de até 1000 caracteres." });
      return;
    }
    const message = {
      id: crypto.randomUUID(),
      slug: session.user.slug,
      text,
      sticker,
      audio: "",
      created: Date.now(),
    };
    store.chatMessages.push(message);
    trimChatMessages();
    saveStore();
    sendJson(res, 201, { message: { id: message.id } });
    return;
  }

  const chatAudioMatch = pathname.match(/^\/api\/chat\/audio\/([a-f0-9-]{36})$/i);
  if (chatAudioMatch && req.method === "GET") {
    const session = requireUser(req, res);
    if (!session) return;
    const message = store.chatMessages.find((entry) => entry.audio === chatAudioMatch[1]);
    if (!message) {
      sendJson(res, 404, { error: "Áudio não encontrado." });
      return;
    }
    const filename = path.join(CHAT_AUDIO_DIR, message.audio + ".audio");
    try {
      const stat = await fs.promises.stat(filename);
      const range = req.headers.range;
      const headers = {
        "cache-control": "private, no-store",
        "content-type": message.audioType || "audio/webm",
        "content-length": stat.size,
        "x-content-type-options": "nosniff",
        "accept-ranges": "bytes",
      };
      if (range) {
        const match = range.match(/^bytes=(\d*)-(\d*)$/);
        if (!match || (!match[1] && !match[2])) {
          res.writeHead(416, { "content-range": "bytes */" + stat.size });
          res.end();
          return;
        }
        const start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]));
        const end = match[2] && match[1] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= stat.size) {
          res.writeHead(416, { "content-range": "bytes */" + stat.size });
          res.end();
          return;
        }
        headers["content-range"] = "bytes " + start + "-" + end + "/" + stat.size;
        headers["content-length"] = end - start + 1;
        res.writeHead(206, headers);
        fs.createReadStream(filename, { start, end }).pipe(res);
        return;
      }
      res.writeHead(200, headers);
      fs.createReadStream(filename).pipe(res);
    } catch (error) {
      if (error.code === "ENOENT") {
        sendJson(res, 404, { error: "Áudio não encontrado." });
        return;
      }
      throw error;
    }
    return;
  }

  if (pathname === "/api/chat/audio" && req.method === "POST") {
    const session = requireUser(req, res);
    if (!session) return;
    if (!checkOrigin(req, res)) return;
    const type = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    const allowedTypes = new Set(["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav", "audio/x-wav"]);
    if (!allowedTypes.has(type)) {
      sendJson(res, 415, { error: "Formato de áudio não suportado. Grave novamente no navegador." });
      return;
    }
    const declaredSize = Number(req.headers["content-length"] || 0);
    if (declaredSize > MAX_CHAT_AUDIO_SIZE) {
      sendJson(res, 413, { error: "O áudio deve ter no máximo 10 MB." });
      return;
    }
    if (!allowChatPost(session.user.discordId)) {
      sendJson(res, 429, { error: "Aguarde um instante antes de enviar outra mensagem." });
      return;
    }
    const chunks = [];
    let totalSize = 0;
    let tooLarge = false;
    for await (const chunk of req) {
      totalSize += chunk.length;
      if (totalSize > MAX_CHAT_AUDIO_SIZE) {
        tooLarge = true;
        chunks.length = 0;
      } else if (!tooLarge) chunks.push(chunk);
    }
    if (tooLarge) {
      sendJson(res, 413, { error: "O áudio deve ter no máximo 10 MB." });
      return;
    }
    if (!totalSize) {
      sendJson(res, 400, { error: "O áudio gravado está vazio." });
      return;
    }
    const text = (url.searchParams.get("text") || "").trim();
    if (text.length > 1000) {
      sendJson(res, 400, { error: "A mensagem junto ao áudio deve ter até 1000 caracteres." });
      return;
    }
    const audio = crypto.randomUUID();
    await fs.promises.writeFile(path.join(CHAT_AUDIO_DIR, audio + ".audio"), Buffer.concat(chunks), { flag: "wx" });
    const message = {
      id: crypto.randomUUID(),
      slug: session.user.slug,
      text,
      audio,
      audioType: type === "audio/x-wav" ? "audio/wav" : type,
      created: Date.now(),
    };
    store.chatMessages.push(message);
    trimChatMessages();
    saveStore();
    sendJson(res, 201, { message: { id: message.id } });
    return;
  }

  if (req.method === "GET" && pathname === "/api/audio-info") {
    const provider = url.searchParams.get("provider");
    const id = url.searchParams.get("id");
    const valid =
      (provider === "spotify" && /^[A-Za-z0-9]{22}$/.test(id || "")) ||
      (provider === "youtube" && /^[A-Za-z0-9_-]{11}$/.test(id || ""));
    if (!valid) {
      sendJson(res, 400, { error: "Link de música inválido." });
      return;
    }
    const key = provider + ":" + id;
    const cached = audioInfoCache.get(key);
    if (cached && cached.expires > Date.now()) {
      sendJson(res, 200, cached.data);
      return;
    }
    const target =
      provider === "spotify"
        ? "https://open.spotify.com/oembed?url=" +
          encodeURIComponent("https://open.spotify.com/track/" + id)
        : "https://www.youtube.com/oembed?format=json&url=" +
          encodeURIComponent("https://www.youtube.com/watch?v=" + id);
    let response;
    try {
      response = await fetch(target, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      throw Object.assign(new Error("Não foi possível carregar os dados da música."), {
        status: error.name === "TimeoutError" ? 504 : 502,
      });
    }
    if (!response.ok) {
      sendJson(res, 404, { error: "Não foi possível encontrar essa música." });
      return;
    }
    let metadata;
    try {
      metadata = await response.json();
    } catch {
      throw Object.assign(new Error("Resposta inválida ao carregar a música."), { status: 502 });
    }
    const image =
      typeof metadata.thumbnail_url === "string" &&
      (provider === "spotify"
        ? /^https:\/\/(image-cdn-ak\.spotifycdn\.com|image-cdn\.scdn\.co|i\.scdn\.co)\//.test(metadata.thumbnail_url)
        : /^https:\/\/i\.ytimg\.com\//.test(metadata.thumbnail_url))
        ? metadata.thumbnail_url
        : "";
    const data = {
      title: typeof metadata.title === "string" ? metadata.title.slice(0, 200) : "",
      image,
    };
    if (audioInfoCache.size >= 500) audioInfoCache.delete(audioInfoCache.keys().next().value);
    audioInfoCache.set(key, { data, expires: Date.now() + 60 * 60 * 1000 });
    sendJson(res, 200, data, { "cache-control": "public, max-age=3600" });
    return;
  }

  const viewMatch = pathname.match(/^\/api\/view\/([a-z0-9_-]{2,20})$/);
  if (req.method === "POST" && viewMatch) {
    if (!checkOrigin(req, res)) return;
    const slug = viewMatch[1];
    if (!store.users[slug]) {
      sendJson(res, 404, { error: "Página não encontrada." });
      return;
    }
    const body = await readJson(req, 16 * 1024);
    const profile = store.profiles[slug] || (store.profiles[slug] = {});
    const views = Number.isSafeInteger(profile.views) ? profile.views : 0;
    const session = currentUser(req);
    if (session && session.user.slug === slug) {
      sendJson(res, 200, { views, counted: false, reason: "owner" });
      return;
    }
    const address = clientIp(req);
    if (!address) {
      sendJson(res, 200, { views, counted: false, reason: "ip_unavailable" });
      return;
    }
    const ipHash = viewIpHash(slug, address);
    const viewedIps = (store.viewedIps[slug] ||= {});
    if (viewedIps[ipHash]) {
      sendJson(res, 200, { views, counted: false, reason: "already_counted" });
      return;
    }
    const day = new Date().toISOString().slice(0, 10);
    profile.views = (Number.isSafeInteger(profile.views) ? profile.views : 0) + 1;
    viewedIps[ipHash] = Date.now();
    profile.vd = profile.vd && typeof profile.vd === "object" && !Array.isArray(profile.vd) ? profile.vd : {};
    profile.vd[day] = (Number.isSafeInteger(profile.vd[day]) ? profile.vd[day] : 0) + 1;
    const device = body.dv === "Celular" ? "Celular" : body.dv === "Computador" ? "Computador" : "Outro";
    profile.dv = profile.dv && typeof profile.dv === "object" && !Array.isArray(profile.dv) ? profile.dv : {};
    profile.dv[device] = (Number.isSafeInteger(profile.dv[device]) ? profile.dv[device] : 0) + 1;
    const source = typeof body.src === "string" ? body.src.trim().slice(0, 120) || "Direto" : "Direto";
    profile.src = profile.src && typeof profile.src === "object" && !Array.isArray(profile.src) ? profile.src : {};
    profile.src[source] = (Number.isSafeInteger(profile.src[source]) ? profile.src[source] : 0) + 1;
    const country = String(req.headers["x-nf-country"] || req.headers["x-country-code"] || "").toUpperCase();
    if (/^[A-Z]{2}$/.test(country) && country !== "XX") {
      profile.ctry = profile.ctry && typeof profile.ctry === "object" && !Array.isArray(profile.ctry) ? profile.ctry : {};
      profile.ctry[country] = (Number.isSafeInteger(profile.ctry[country]) ? profile.ctry[country] : 0) + 1;
    }
    store.profiles[slug] = profile;
    saveStore();
    sendJson(res, 200, { views: profile.views, counted: true });
    return;
  }

  const clickMatch = pathname.match(/^\/api\/click\/([a-z0-9_-]{2,20})$/);
  if (req.method === "POST" && clickMatch) {
    if (!checkOrigin(req, res)) return;
    const slug = clickMatch[1];
    if (!store.users[slug]) {
      sendJson(res, 404, { error: "Página não encontrada." });
      return;
    }
    const body = await readJson(req, 16 * 1024);
    const profile = store.profiles[slug] || (store.profiles[slug] = {});
    const day = new Date().toISOString().slice(0, 10);
    profile.clicks = (Number.isSafeInteger(profile.clicks) ? profile.clicks : 0) + 1;
    profile.cd = profile.cd && typeof profile.cd === "object" && !Array.isArray(profile.cd) ? profile.cd : {};
    profile.cd[day] = (Number.isSafeInteger(profile.cd[day]) ? profile.cd[day] : 0) + 1;
    const name = typeof body.n === "string" ? body.n.trim().slice(0, 80) || "Link" : "Link";
    profile.nc = profile.nc && typeof profile.nc === "object" && !Array.isArray(profile.nc) ? profile.nc : {};
    profile.nc[name] = (Number.isSafeInteger(profile.nc[name]) ? profile.nc[name] : 0) + 1;
    store.profiles[slug] = profile;
    saveStore();
    sendJson(res, 200, { clicks: profile.clicks });
    return;
  }

  if (req.method === "GET" && pathname === "/api/stats") {
    const views = Object.values(store.profiles).reduce(
      (total, profile) => total + (Number.isSafeInteger(profile.views) ? profile.views : 0),
      0,
    );
    const users = Object.keys(store.users).length;
    const subs = Object.values(store.users).filter((user) => user.premium).length;
    const uploads = (await fs.promises.readdir(UPLOAD_DIR, { withFileTypes: true })).filter((entry) =>
      entry.isFile(),
    ).length;
    sendJson(res, 200, { views, users, uploads, subs });
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
      dcPremiumType: session.user.premiumType || 0,
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
      dcPremiumType: user.premiumType || 0,
    });
    sendJson(res, 200, {
      slug,
      profile,
      meta: Object.assign(publicUser(user), { views: Number.isSafeInteger(profile.views) ? profile.views : 0 }),
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/templates") {
    const session = currentUser(req);
    if (!session) {
      sendJson(res, 401, { error: "Entre com o Discord para continuar." });
      return;
    }
    const user = session.user;
    const tab = url.searchParams.get("tab") || "library";
    if (!["library", "favs", "recent", "mine"].includes(tab)) {
      sendJson(res, 400, { error: "Filtro de templates inválido." });
      return;
    }
    const query = (url.searchParams.get("q") || "").trim().slice(0, 60).toLocaleLowerCase();
    const ownerFilter = (url.searchParams.get("user") || "").trim().slice(0, 20).toLocaleLowerCase();
    const sort = url.searchParams.get("sort") || "hot";
    const favorites = store.templateFavorites[user.discordId] || [];
    const recent = store.templateRecent[user.discordId] || [];
    let templates = Object.values(store.templates).filter((template) => {
      if (tab === "mine") return templateOwnedBy(template, user);
      if (!templateAccessible(template, user)) return false;
      if (tab === "favs" && !favorites.includes(template.id)) return false;
      if (tab === "recent" && !recent.includes(template.id)) return false;
      if (tab === "library" && template.vis !== "public") return false;
      if (ownerFilter && template.ownerSlug.toLocaleLowerCase() !== ownerFilter) return false;
      if (
        query &&
        !template.name.toLocaleLowerCase().includes(query) &&
        !template.tags.some((tag) => tag.toLocaleLowerCase().includes(query))
      ) {
        return false;
      }
      if (sort === "free" && template.premium) return false;
      if (sort === "premium" && !template.premium) return false;
      return true;
    });
    if (tab === "recent") {
      templates.sort((a, b) => recent.indexOf(a.id) - recent.indexOf(b.id));
    } else if (sort === "old") {
      templates.sort((a, b) => a.created - b.created);
    } else if (sort === "recent") {
      templates.sort((a, b) => b.created - a.created);
    } else {
      templates.sort((a, b) => b.uses + templateStars(b.id) * 3 - (a.uses + templateStars(a.id) * 3) || b.created - a.created);
    }
    sendJson(res, 200, {
      templates: templates.slice(0, 100).map((template) => publicTemplate(template, user)),
      mine: Object.values(store.templates).filter((template) => templateOwnedBy(template, user)).length,
      max: TEMPLATE_LIMIT,
    });
    return;
  }

  const templateMatch = pathname.match(/^\/api\/templates\/(\d{1,9})(?:\/(fav|use))?$/);
  if (req.method === "GET" && templateMatch && !templateMatch[2]) {
    const template = store.templates[templateMatch[1]];
    const user = currentUser(req)?.user || null;
    if (!templateAccessible(template, user)) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    sendJson(res, 200, { template: publicTemplate(template, user, true) });
    return;
  }

  const session = requireUser(req, res);
  if (!session) return;

  const personalTemplateMatch = pathname.match(/^\/api\/profile-templates(?:\/([a-f0-9-]{36}))?$/i);
  if (personalTemplateMatch && req.method === "GET") {
    const templates = store.profileTemplates[session.user.discordId] || [];
    if (personalTemplateMatch[1]) {
      const template = templates.find((item) => item.id === personalTemplateMatch[1]);
      if (!template) {
        sendJson(res, 404, { error: "Template não encontrado." });
        return;
      }
      sendJson(res, 200, { template });
      return;
    }
    sendJson(
      res,
      200,
      { templates: templates.map(({ id, name, created }) => ({ id, name, created })), max: PROFILE_TEMPLATE_LIMIT },
    );
    return;
  }

  if (personalTemplateMatch && req.method === "POST" && !personalTemplateMatch[1]) {
    if (!checkOrigin(req, res)) return;
    const body = await readJson(req, 2 * 1024 * 1024);
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 40) : "";
    if (!name) {
      sendJson(res, 400, { error: "Dê um nome para o template." });
      return;
    }
    if (!body.profile || typeof body.profile !== "object" || Array.isArray(body.profile)) {
      sendJson(res, 400, { error: "Perfil do template inválido." });
      return;
    }
    const templates = (store.profileTemplates[session.user.discordId] ||= []);
    if (templates.length >= PROFILE_TEMPLATE_LIMIT) {
      sendJson(res, 403, { error: "Você atingiu o limite de templates pessoais." });
      return;
    }
    const profile = templateProfileSnapshot(body.profile);
    if (Buffer.byteLength(JSON.stringify(profile), "utf8") > MAX_PROFILE_TEMPLATE_SIZE) {
      sendJson(res, 413, { error: "O perfil está grande demais para virar template." });
      return;
    }
    const template = { id: crypto.randomUUID(), name, created: Date.now(), profile };
    templates.unshift(template);
    saveStore();
    sendJson(res, 201, { template: { id: template.id, name: template.name, created: template.created } });
    return;
  }

  if (personalTemplateMatch && req.method === "DELETE" && personalTemplateMatch[1]) {
    if (!checkOrigin(req, res)) return;
    const templates = store.profileTemplates[session.user.discordId] || [];
    const index = templates.findIndex((item) => item.id === personalTemplateMatch[1]);
    if (index < 0) {
      sendJson(res, 404, { error: "Template não encontrado." });
      return;
    }
    templates.splice(index, 1);
    saveStore();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && pathname === "/api/templates") {
    if (!checkOrigin(req, res)) return;
    const body = await readJson(req, 2 * 1024 * 1024);
    const owned = Object.values(store.templates).filter((template) => templateOwnedBy(template, session.user));
    if (owned.length >= TEMPLATE_LIMIT) {
      sendJson(res, 403, { error: "limit" });
      return;
    }
    if (!body.profile || typeof body.profile !== "object" || Array.isArray(body.profile)) {
      sendJson(res, 400, { error: "Perfil do template inválido." });
      return;
    }
    const fields = cleanTemplateFields(body);
    let id;
    do {
      id = String(crypto.randomInt(100000000, 1000000000));
    } while (store.templates[id]);
    const template = {
      id,
      ...fields,
      ownerId: session.user.discordId,
      ownerSlug: session.user.slug,
      ownerName: session.user.dn,
      created: Date.now(),
      uses: 0,
      premium: false,
    };
    store.templates[id] = template;
    saveStore();
    sendJson(res, 201, { template: publicTemplate(template, session.user, true) });
    return;
  }

  if (templateMatch && templateMatch[2] === "fav" && req.method === "POST") {
    if (!checkOrigin(req, res)) return;
    const template = store.templates[templateMatch[1]];
    if (!template || templateOwnedBy(template, session.user) || template.vis === "private") {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    const favorites = (store.templateFavorites[session.user.discordId] ||= []);
    const index = favorites.indexOf(template.id);
    if (index >= 0) favorites.splice(index, 1);
    else favorites.push(template.id);
    saveStore();
    sendJson(res, 200, { template: publicTemplate(template, session.user) });
    return;
  }

  if (templateMatch && templateMatch[2] === "use" && req.method === "POST") {
    if (!checkOrigin(req, res)) return;
    const template = store.templates[templateMatch[1]];
    if (!templateAccessible(template, session.user)) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    const current = store.profiles[session.user.slug] || {};
    const keep = new Set(["dcId", "views", "vd", "dv", "src", "clicks", "cd", "nc", "ctry"]);
    [
      "desc",
      "loc",
      "avatar",
      "links",
      "audios",
      "audio",
      "audioN",
      "act",
      "shuf",
      "apl",
      "dn",
      "uid",
      "alias",
    ].forEach((key) => keep.add(key));
    const profile = Object.assign({}, template.profile);
    keep.forEach((key) => {
      if (Object.hasOwn(current, key)) profile[key] = current[key];
      else delete profile[key];
    });
    if (Object.hasOwn(current, "desc")) {
      profile.desc = applyTemplateBioStyles(current.desc, template.profile.desc);
    }
    profile.dcId = session.user.discordId;
    const clean = cleanProfile(profile);
    if (Buffer.byteLength(JSON.stringify(clean), "utf8") > MAX_TEMPLATE_PROFILE_SIZE) {
      sendJson(res, 413, { error: "too_large" });
      return;
    }
    store.profiles[session.user.slug] = clean;
    template.uses = (Number.isSafeInteger(template.uses) ? template.uses : 0) + 1;
    const recent = (store.templateRecent[session.user.discordId] ||= []);
    const previous = recent.indexOf(template.id);
    if (previous >= 0) recent.splice(previous, 1);
    recent.unshift(template.id);
    recent.length = Math.min(recent.length, 50);
    saveStore();
    sendJson(res, 200, { profile: clean });
    return;
  }

  if (templateMatch && !templateMatch[2] && req.method === "PATCH") {
    if (!checkOrigin(req, res)) return;
    const template = store.templates[templateMatch[1]];
    if (!template) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    if (!templateOwnedBy(template, session.user)) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    const body = await readJson(req, 2 * 1024 * 1024);
    const fields = cleanTemplateFields(body, template);
    Object.assign(template, fields, {
      ownerSlug: session.user.slug,
      ownerName: session.user.dn,
    });
    saveStore();
    sendJson(res, 200, { template: publicTemplate(template, session.user, true) });
    return;
  }

  if (templateMatch && !templateMatch[2] && req.method === "DELETE") {
    if (!checkOrigin(req, res)) return;
    const template = store.templates[templateMatch[1]];
    if (!template) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    if (!templateOwnedBy(template, session.user)) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    delete store.templates[template.id];
    for (const favorites of Object.values(store.templateFavorites)) {
      if (Array.isArray(favorites)) {
        const index = favorites.indexOf(template.id);
        if (index >= 0) favorites.splice(index, 1);
      }
    }
    for (const recent of Object.values(store.templateRecent)) {
      if (Array.isArray(recent)) {
        const index = recent.indexOf(template.id);
        if (index >= 0) recent.splice(index, 1);
      }
    }
    saveStore();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && pathname === "/api/rename") {
    if (!checkOrigin(req, res)) return;
    const body = await readJson(req, 16 * 1024);
    const slug = typeof body.slug === "string" ? body.slug : "";
    if (!/^[a-z0-9_-]{2,20}$/.test(slug) || RESERVED_SLUGS.has(slug)) {
      sendJson(res, 400, { error: "Nome de usuário inválido ou reservado." });
      return;
    }
    if (slug === session.user.slug) {
      sendJson(res, 400, { error: "Esse já é o seu nome de usuário." });
      return;
    }
    if (store.users[slug]) {
      sendJson(res, 409, { error: "Esse nome de usuário já está em uso." });
      return;
    }

    const oldSlug = session.user.slug;
    const user = session.user;
    delete store.users[oldSlug];
    user.slug = slug;
    store.users[slug] = user;
    if (Object.hasOwn(store.profiles, oldSlug)) {
      store.profiles[slug] = store.profiles[oldSlug];
      delete store.profiles[oldSlug];
    }
    store.chatMessages.forEach((message) => {
      if (message.slug === oldSlug) message.slug = slug;
    });
    for (const activeSession of Object.values(store.sessions)) {
      if (activeSession.slug === oldSlug) activeSession.slug = slug;
    }
    for (const upload of uploadParts.values()) {
      if (upload.slug === oldSlug) upload.slug = slug;
    }
    for (const template of Object.values(store.templates)) {
      if (templateOwnedBy(template, user)) {
        template.ownerSlug = slug;
        template.ownerName = user.dn;
      }
    }
    if (Object.hasOwn(store.viewedIps, oldSlug)) {
      store.viewedIps[slug] = store.viewedIps[oldSlug];
      delete store.viewedIps[oldSlug];
    }
    saveStore();
    sendJson(res, 200, { user: publicUser(user) });
    return;
  }

  if (req.method === "PUT" && pathname === "/api/profile") {
    if (!checkOrigin(req, res)) return;
    const body = await readJson(req);
    if (!body.profile || typeof body.profile !== "object" || Array.isArray(body.profile)) {
      sendJson(res, 400, { error: "Perfil inválido." });
      return;
    }
    const profile = cleanProfile(body.profile);
    profile.dcId = session.user.discordId;
    delete profile.dcPremiumType;
    const existing = store.profiles[session.user.slug] || {};
    for (const key of ["views", "vd", "dv", "src", "clicks", "cd", "nc", "ctry"]) {
      if (existing[key] !== undefined) profile[key] = existing[key];
    }
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

  if (req.method === "POST" && /^\/api\/upload\/part(?:\/|$)/.test(pathname)) {
    if (!checkOrigin(req, res)) return;
    const partRoute = pathname.match(/^\/api\/upload\/part\/([a-f0-9]{32})\/(\d+)\/(\d+)$/i);
    const id = partRoute ? partRoute[1] : url.searchParams.get("id") || "";
    const index = Number(partRoute ? partRoute[2] : url.searchParams.get("i"));
    const count = Number(partRoute ? partRoute[3] : url.searchParams.get("n"));
    if (
      !/^[a-f0-9]{32}$/i.test(id) ||
      !Number.isInteger(index) ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > MAX_UPLOAD_PARTS ||
      index < 0 ||
      index >= count
    ) {
      sendJson(res, 400, { error: "Parte de upload inválida." });
      return;
    }
    const now = Date.now();
    for (const [key, upload] of uploadParts) {
      if (now - upload.updated > 30 * 60 * 1000) {
        uploadParts.delete(key);
        try {
          await fs.promises.unlink(upload.path);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    }
    let upload = uploadParts.get(id);
    if (!upload) {
      const active = [...uploadParts.values()].filter((item) => item.slug === session.user.slug).length;
      if (active >= 8) {
        sendJson(res, 429, { error: "Muitos uploads em andamento." });
        return;
      }
      const uploadPath = path.join(UPLOAD_PART_DIR, id + ".part");
      const handle = await fs.promises.open(uploadPath, "wx");
      await handle.close();
      upload = { slug: session.user.slug, count, path: uploadPath, received: new Map(), totalBytes: 0, updated: now };
      uploadParts.set(id, upload);
    }
    if (upload.slug !== session.user.slug || upload.count !== count) {
      sendJson(res, 400, { error: "Upload inválido." });
      return;
    }
    const chunk = await readBody(req, UPLOAD_CHUNK_SIZE);
    if (!chunk.length || (index < count - 1 && chunk.length !== UPLOAD_CHUNK_SIZE)) {
      sendJson(res, 400, { error: "Tamanho da parte de upload inválido." });
      return;
    }
    const oldLength = upload.received.get(index);
    if (oldLength !== undefined && oldLength !== chunk.length) {
      sendJson(res, 400, { error: "Parte reenviada com tamanho diferente." });
      return;
    }
    if (oldLength === undefined && upload.totalBytes + chunk.length > MAX_UPLOAD_SIZE) {
      sendJson(res, 413, { error: "Arquivo maior que 1 GB." });
      return;
    }
    const handle = await fs.promises.open(upload.path, "r+");
    try {
      let written = 0;
      const position = index * UPLOAD_CHUNK_SIZE;
      while (written < chunk.length) {
        const result = await handle.write(chunk, written, chunk.length - written, position + written);
        if (!result.bytesWritten) throw new Error("Falha ao gravar parte do upload.");
        written += result.bytesWritten;
      }
    } finally {
      await handle.close();
    }
    if (oldLength === undefined) {
      upload.received.set(index, chunk.length);
      upload.totalBytes += chunk.length;
    }
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
      upload.received.size !== upload.count
    ) {
      sendJson(res, 400, { error: "Upload incompleto ou expirado." });
      return;
    }
    const lastChunkSize = upload.received.get(upload.count - 1);
    const totalBytes = (upload.count - 1) * UPLOAD_CHUNK_SIZE + lastChunkSize;
    if (
      !Number.isInteger(lastChunkSize) ||
      lastChunkSize < 1 ||
      lastChunkSize > UPLOAD_CHUNK_SIZE ||
      totalBytes !== upload.totalBytes ||
      totalBytes > MAX_UPLOAD_SIZE
    ) {
      uploadParts.delete(body.id);
      await fs.promises.unlink(upload.path);
      sendJson(res, 413, { error: "Arquivo maior que 1 GB." });
      return;
    }
    const extension = uploadExtension(String(body.mime || "").toLowerCase());
    const filename = crypto.randomUUID() + extension;
    await fs.promises.rename(upload.path, path.join(UPLOAD_DIR, filename));
    uploadParts.delete(body.id);
    sendJson(res, 200, { url: "/uploads/" + filename });
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
    deleteChatMessagesBySlug(session.user.slug);
    const discordId = session.user.discordId;
    store.chatFriendRequests = store.chatFriendRequests.filter(
      (request) => request.fromId !== discordId && request.toId !== discordId,
    );
    const removedFriendships = new Set(
      store.chatFriendships
        .filter((friendship) => friendship.a === discordId || friendship.b === discordId)
        .map((friendship) => friendship.id),
    );
    store.chatFriendships = store.chatFriendships.filter((friendship) => !removedFriendships.has(friendship.id));
    store.chatDmMessages = store.chatDmMessages.filter(
      (message) => message.fromId !== discordId && message.toId !== discordId,
    );
    delete store.users[session.user.slug];
    delete store.profiles[session.user.slug];
    delete store.viewedIps[session.user.slug];
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
  const isLocalTestPath = decoded === "/local-test" || decoded === "/local-test/";
  if (isLocalTestPath) {
    if (!isLoopback(req)) {
      sendJson(res, 404, { error: "Arquivo não encontrado." });
      return;
    }
  }
  const uploadName = decoded.startsWith("/uploads/") ? decoded.slice("/uploads/".length) : "";
  const isAllowedUpload = !!uploadName && path.basename(uploadName) === uploadName;
  const isPublicFile = ["/", "/index.html", "/hero-bg.jpg", "/shooting-banner.jpg"].includes(decoded);
  const isAppRoute = !path.extname(decoded) && !decoded.startsWith("/uploads/");
  if (!isAllowedUpload && !isPublicFile && !isAppRoute && !isLocalTestPath) {
    sendJson(res, 404, { error: "Arquivo não encontrado." });
    return;
  }
  const relative = isAllowedUpload
    ? path.join("uploads", uploadName)
    : isLocalTestPath
      ? path.join("local-test", "index.html")
      : isAppRoute
      ? "index.html"
      : decoded.slice(1);
  const file = path.resolve(ROOT, relative);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    sendJson(res, 403, { error: "Caminho não permitido." });
    return;
  }
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) throw Object.assign(new Error("Not a file"), { code: "ENOENT" });
    const headers = {
      "cache-control": file.endsWith("index.html") ? "no-cache" : "public, max-age=3600",
      "content-length": stat.size,
      "content-type": mimeTypes[path.extname(file).toLowerCase()] || "application/octet-stream",
      "x-content-type-options": "nosniff",
    };
    const range = req.headers.range;
    if (isAllowedUpload && range) {
      const match = range.match(/^bytes=(\d*)-(\d*)$/);
      if (!match || (!match[1] && !match[2])) {
        res.writeHead(416, { "content-range": "bytes */" + stat.size });
        res.end();
        return;
      }
      let start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]));
      let end = match[2] && match[1] ? Number(match[2]) : stat.size - 1;
      if (!match[1] && match[2]) end = stat.size - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= stat.size) {
        res.writeHead(416, { "content-range": "bytes */" + stat.size });
        res.end();
        return;
      }
      end = Math.min(end, stat.size - 1);
      headers["accept-ranges"] = "bytes";
      headers["content-range"] = "bytes " + start + "-" + end + "/" + stat.size;
      headers["content-length"] = end - start + 1;
      res.writeHead(206, headers);
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    if (isAllowedUpload) headers["accept-ranges"] = "bytes";
    res.writeHead(200, headers);
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
