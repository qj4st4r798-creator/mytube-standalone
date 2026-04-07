const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const Busboy = require("busboy");
const cookie = require("cookie");
const initSqlJs = require("sql.js");

const PORT = Number(process.env.PORT || 3000);
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 1000 * 60 * 60 * 24 * 7);
const MAX_JSON_BYTES = Number(process.env.MAX_REQUEST_BYTES || 1024 * 1024 * 10);
const ROOT = __dirname;
const ABS_ROOT = path.resolve(ROOT);
const UPLOADS_DIR = path.join(ROOT, "uploads");
const ABS_UPLOADS = path.resolve(UPLOADS_DIR);
const DATA_DIR = path.join(ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "mytube.sqlite");
const LEGACY_USERS_FILE = path.join(DATA_DIR, "users.json");
const LEGACY_VIDEOS_FILE = path.join(DATA_DIR, "videos.json");
const SESSION_COOKIE = "mytube_session";
const STOCK_SYMBOLS = ["AAPL.US","MSFT.US","NVDA.US","TSLA.US","AMZN.US","GOOG.US","META.US","SPY.US"];
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 1024 * 1024 * 512);
const ALLOWED_IMAGE_TYPES = new Set(["image/png","image/jpeg","image/webp","image/gif"]);
const ALLOWED_VIDEO_TYPES = new Set(["video/mp4","video/webm","video/quicktime"]);
const AUTH_WINDOW_MS = 1000 * 60 * 15;
const MAX_LOGIN_ATTEMPTS = 10;
const MAX_SIGNUP_ATTEMPTS = 5;
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
};
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ico": "image/x-icon",
};
const authLimiter = new Map();
function ensureDirectories() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

let db;

bootstrap().catch(err => {
  console.error(err);
  process.exit(1);
});

async function bootstrap() {
  ensureDirectories();
  const SQL = await initSqlJs({
    locateFile: f => path.join(path.dirname(require.resolve("sql.js/dist/sql-wasm.js")), f),
  });

  db = fs.existsSync(DB_FILE)
    ? new SQL.Database(fs.readFileSync(DB_FILE))
    : new SQL.Database();

  initDb();
  migrateLegacyJsonData();
  clearExpiredSessions();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (isMutationMethod(req.method)) assertSameOrigin(req);
      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url);
        return;
      }
      serveStatic(req, res, url.pathname);
    } catch (err) {
      if (err.message === "Request body too large.") {
        sendJson(res, 413, { error: "Upload is too large." });
        return;
      }
      if (err.message === "Origin mismatch.") {
        sendJson(res, 403, { error: "Cross-site request blocked." });
        return;
      }
      sendJson(res, 500, { error: "Internal server error", detail: err.message });
    }
  });

  server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}
async function handleApi(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (req.method === "OPTIONS") {
    sendOptions(res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/login") {
    const body = await readJson(req);
    if (!consumeRateLimit(`login:${clientIp(req)}:${String(body.email||"").toLowerCase()}`, MAX_LOGIN_ATTEMPTS, AUTH_WINDOW_MS)) {
      sendJson(res, 429, { error: "Too many login attempts." });
      return;
    }
    const user = get("SELECT * FROM users WHERE lower(email)=lower(?)", [String(body.email||"").trim()]);
    if (!user || !verifyPassword(user, String(body.password||""))) {
      sendJson(res, 401, { error: "Invalid email or password." });
      return;
    }
    clearRateLimit(`login:${clientIp(req)}:${String(body.email||"").toLowerCase()}`);
    const token = createSession(user.id);
    sendJson(res, 200, { user: publicUser(user.id) }, [sessionCookie(token)]);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/logout") {
    const session = getSession(req);
    if (session) run("DELETE FROM sessions WHERE id = ?", [session.id], true);
    sendJson(res, 200, { ok: true }, [clearSessionCookie()]);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/signup") {
    const body = await readJson(req);
    if (!consumeRateLimit(`signup:${clientIp(req)}`, MAX_SIGNUP_ATTEMPTS, AUTH_WINDOW_MS)) {
      sendJson(res, 429, { error: "Too many signup attempts." });
      return;
    }
    const email = String(body.email||"").trim().toLowerCase();
    const password = String(body.password||"");
    const fullName = String(body.full_name||"").trim();
    const channelName = slugFromText(body.channel_name || fullName || email.split("@")[0]);

    if (!email || !password || !fullName) {
      sendJson(res, 400, { error: "Missing fields." });
      return;
    }
    if (password.length < 8) {
      sendJson(res, 400, { error: "Password too short." });
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      sendJson(res, 400, { error: "Invalid email." });
      return;
    }
    if (get("SELECT id FROM users WHERE lower(email)=lower(?)", [email])) {
      sendJson(res, 409, { error: "Email already exists." });
      return;
    }

    const userId = createId("user");
    const pass = createPasswordHash(password);

    run(
      "INSERT INTO users (id,email,full_name,channel_name,role,password_hash,password_salt,created_at) VALUES (?,?,?,?, 'user',?,?,?)",
      [userId, email, fullName, channelName, pass.hash, pass.salt, new Date().toISOString()],
      true
    );

    const token = createSession(userId);
    sendJson(res, 201, { user: publicUser(userId) }, [sessionCookie(token)]);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/me") {
    const user = requireUser(req, res);
    if (!user) return;
    sendJson(res, 200, publicUser(user.id));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/videos") {
    const user = requireUser(req, res);
    if (!user) return;
    sendJson(res, 200, { videos: listVideos() });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/stocks") {
    const user = requireUser(req, res);
    if (!user) return;
    try {
      const stocks = await fetchStocks();
      sendJson(res, 200, { stocks, updated_at: new Date().toISOString() });
    } catch {
      sendJson(res, 502, { error: "Stock fetch failed." });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/videos") {
    const user = requireUser(req, res);
    if (!user) return;

    const { fields, files } = await parseMultipart(req);
    const title = String(fields.title || "").trim();
    const isLive = toBoolean(fields.is_live);

    if (!title) {
      removeUploadedFiles(files);
      sendJson(res, 400, { error: "A video title is required." });
      return;
    }

    if (!isLive && !files.video_file) {
      removeUploadedFiles(files);
      sendJson(res, 400, { error: "Please upload a video file." });
      return;
    }

    const videoId = createId("video");

    run(
      `INSERT INTO videos (
        id, title, description, thumbnail_url, video_url, current_frame_url,
        channel_name, owner_id, category, tags_json, views, duration,
        is_live, is_music, created_at
      ) VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      [
        videoId,
        title,
        String(fields.description || "").trim(),
        files.thumbnail_file ? `/uploads/${files.thumbnail_file.fileName}` : "",
        files.video_file ? `/uploads/${files.video_file.fileName}` : "",
        user.channel_name,
        user.id,
        String(fields.category || "general").trim() || "general",
        JSON.stringify(parseTags(fields.tags)),
        String(fields.duration || "0:00").trim() || "0:00",
        isLive ? 1 : 0,
        toBoolean(fields.is_music) ? 1 : 0,
        new Date().toISOString()
      ],
      true
    );

    sendJson(res, 201, { video: getVideoById(videoId) });
    return;
  }
  if (parts[1] === "videos" && parts[2]) {
    const videoId = parts[2];

    if (req.method === "DELETE" && parts.length === 3) {
      const user = requireUser(req, res);
      if (!user) return;
      const video = getVideoRow(videoId);
      if (!video) {
        sendJson(res, 404, { error: "Video not found." });
        return;
      }
      if (user.role !== "admin" && user.id !== video.owner_id) {
        sendJson(res, 403, { error: "You cannot delete this video." });
        return;
      }

      const thumbPath = path.join(UPLOADS_DIR, path.basename(video.thumbnail_url));
      const videoPath = path.join(UPLOADS_DIR, path.basename(video.video_url));
      fs.rm(thumbPath, { force: true }, () => {});
      fs.rm(videoPath, { force: true }, () => {});

      run("DELETE FROM likes WHERE video_id = ?", [videoId]);
      run("DELETE FROM history WHERE video_id = ?", [videoId]);
      run("DELETE FROM reports WHERE video_id = ?", [videoId]);
      run("DELETE FROM videos WHERE id = ?", [videoId], true);

      sendJson(res, 200, { ok: true });
      return;
    }

    if (parts[3] === "signal") {
      if (req.method === "POST") {
        const body = await readJson(req);
        const type = String(body.type || "").trim();
        const validTypes = new Set(["offer", "answer", "candidate"]);
        if (!validTypes.has(type)) {
          sendJson(res, 400, { error: "Invalid signal type." });
          return;
        }

        const payload = { type };
        if (type === "offer") {
          if (!body.offer) {
            sendJson(res, 400, { error: "Offer payload is required." });
            return;
          }
          payload.offer = body.offer;
        } else if (type === "answer") {
          if (!body.answer) {
            sendJson(res, 400, { error: "Answer payload is required." });
            return;
          }
          payload.answer = body.answer;
        } else if (type === "candidate") {
          if (!body.candidate) {
            sendJson(res, 400, { error: "Candidate payload is required." });
            return;
          }
          payload.candidate = body.candidate;
        }

        const source = body.source === "viewer" ? "viewer" : "broadcaster";
        run(
          "INSERT INTO signals (id, video_id, payload, created_at, source) VALUES (?, ?, ?, ?, ?)",
          [crypto.randomUUID(), videoId, JSON.stringify(payload), new Date().toISOString(), source],
          true
        );
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "GET") {
        const role = String(url.searchParams.get("for") || "viewer").toLowerCase();
        const desiredSource = role === "broadcaster" ? "viewer" : "broadcaster";
        const rows = all(
          "SELECT id, payload FROM signals WHERE video_id = ? AND source = ? ORDER BY created_at ASC",
          [videoId, desiredSource]
        );
        const signals = [];
        for (const row of rows) {
          try {
            signals.push(JSON.parse(row.payload));
          } catch {
            // Skip malformed payloads.
          }
        }
        if (rows.length) {
          const ids = rows.map((row) => row.id);
          const placeholders = ids.map(() => "?").join(",");
          run(`DELETE FROM signals WHERE id IN (${placeholders})`, ids, true);
        }
        sendJson(res, 200, { signals });
        return;
      }
    }

    if (req.method === "POST" && parts[3] === "toggle-like") {
      const user = requireUser(req, res);
      if (!user) return;
      if (!getVideoRow(videoId)) {
        sendJson(res, 404, { error: "Video not found." });
        return;
      }
      const existing = get(
        "SELECT 1 AS ok FROM likes WHERE user_id = ? AND video_id = ?",
        [user.id, videoId]
      );
      if (existing) {
        run("DELETE FROM likes WHERE user_id = ? AND video_id = ?", [user.id, videoId], true);
      } else {
        run(
          "INSERT INTO likes (user_id, video_id, created_at) VALUES (?, ?, ?)",
          [user.id, videoId, new Date().toISOString()],
          true
        );
      }
      sendJson(res, 200, { liked: !existing });
      return;
    }

    if (req.method === "POST" && parts[3] === "view") {
      const user = requireUser(req, res);
      if (!user) return;
      if (!getVideoRow(videoId)) {
        sendJson(res, 404, { error: "Video not found." });
        return;
      }
      run("UPDATE videos SET views = views + 1 WHERE id = ?", [videoId]);
      run("DELETE FROM history WHERE user_id = ? AND video_id = ?", [user.id, videoId]);
      run(
        "INSERT INTO history (user_id, video_id, viewed_at) VALUES (?, ?, ?)",
        [user.id, videoId, new Date().toISOString()],
        true
      );
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && parts[3] === "report") {
      const user = requireUser(req, res);
      if (!user) return;
      if (!getVideoRow(videoId)) {
        sendJson(res, 404, { error: "Video not found." });
        return;
      }
      const body = await readJson(req);
      const existing = get(
        "SELECT 1 AS ok FROM reports WHERE user_id = ? AND video_id = ?",
        [user.id, videoId]
      );
      if (!existing) {
        run(
          "INSERT INTO reports (id, video_id, user_id, email, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          [
            createId("report"),
            videoId,
            user.id,
            user.email,
            String(body.reason || "Inappropriate content").trim(),
            new Date().toISOString()
          ],
          true
        );
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && parts[3] === "frame") {
      const user = requireUser(req, res);
      if (!user) return;
      const video = getVideoRow(videoId);
      if (!video) {
        sendJson(res, 404, { error: "Video not found." });
        return;
      }
      if (user.role !== "admin" && user.id !== video.owner_id) {
        sendJson(res, 403, { error: "You cannot update this stream." });
        return;
      }
      const body = await readJson(req);
      const frame = String(body.current_frame_url || "").trim();
      run(
        "UPDATE videos SET current_frame_url = ?, thumbnail_url = CASE WHEN thumbnail_url = '' THEN ? ELSE thumbnail_url END WHERE id = ?",
        [frame, frame, videoId],
        true
      );
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && parts[3] === "stop-live") {
      const user = requireUser(req, res);
      if (!user) return;
      const video = getVideoRow(videoId);
      if (!video) {
        sendJson(res, 404, { error: "Video not found." });
        return;
      }
      if (user.role !== "admin" && user.id !== video.owner_id) {
        sendJson(res, 403, { error: "You cannot stop this stream." });
        return;
      }
      run("UPDATE videos SET is_live = 0 WHERE id = ?", [videoId], true);
      run("DELETE FROM signals WHERE video_id = ?", [videoId], true);
      sendJson(res, 200, { ok: true });
      return;
    }
  }
  if (parts[1] === "channels" && parts[2] && req.method === "POST" && parts[3] === "subscribe") {
    const user = requireUser(req, res);
    if (!user) return;

    const channelName = decodeURIComponent(parts[2]);
    if (channelName === user.channel_name) {
      sendJson(res, 400, { error: "You cannot subscribe to yourself." });
      return;
    }

    const existing = get(
      "SELECT 1 FROM subscriptions WHERE user_id = ? AND channel_name = ?",
      [user.id, channelName]
    );

    if (existing) {
      run(
        "DELETE FROM subscriptions WHERE user_id = ? AND channel_name = ?",
        [user.id, channelName],
        true
      );
      sendJson(res, 200, { subscribed: false });
      return;
    }

    run(
      "INSERT INTO subscriptions (user_id, channel_name, created_at) VALUES (?, ?, ?)",
      [user.id, channelName, new Date().toISOString()],
      true
    );

    sendJson(res, 200, { subscribed: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/reports") {
    const user = requireUser(req, res);
    if (!user) return;
    if (user.role !== "admin") {
      sendJson(res, 403, { error: "Admin access required." });
      return;
    }

    const videos = listVideos()
      .filter(v => v.report_count > 0)
      .sort((a, b) => b.report_count - a.report_count);

    sendJson(res, 200, { videos });
    return;
  }

  sendJson(res, 404, { error: "Not found." });
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => {
      data += chunk;
      if (data.length > MAX_JSON_BYTES) reject(new Error("Request body too large."));
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        reject(new Error("Invalid JSON."));
      }
    });
  });
}

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers, limits: { fileSize: MAX_UPLOAD_BYTES } });
    const fields = {};
    const files = {};

    busboy.on("field", (name, val) => {
      fields[name] = val;
    });

    busboy.on("file", (name, file, info) => {
      const { filename, mimeType } = info;
      const safeName = crypto.randomUUID() + path.extname(filename);
      const savePath = path.join(UPLOADS_DIR, safeName);

      const out = fs.createWriteStream(savePath);
      file.pipe(out);

      files[name] = {
        fileName: safeName,
        mimeType
      };
    });

    busboy.on("finish", () => resolve({ fields, files }));
    busboy.on("error", reject);

    req.pipe(busboy);
  });
}

function removeUploadedFiles(files) {
  for (const key in files) {
    const f = files[key];
    const p = path.join(UPLOADS_DIR, f.fileName);
    fs.rm(p, { force: true }, () => {});
  }
}

function requireUser(req, res) {
  const session = getSession(req);
  if (!session) {
    sendJson(res, 401, { error: "Not authenticated." });
    return null;
  }
  const user = get("SELECT * FROM users WHERE id = ?", [session.user_id]);
  if (!user) {
    sendJson(res, 401, { error: "Invalid session." });
    return null;
  }
  return user;
}

function publicUser(userId) {
  const user = get(
    "SELECT id,email,full_name,channel_name,role,created_at FROM users WHERE id = ?",
    [userId]
  );
  if (!user) return null;

  const liked = all("SELECT video_id FROM likes WHERE user_id = ?", [userId]).map((row) => row.video_id);
  const history = all("SELECT video_id FROM history WHERE user_id = ? ORDER BY viewed_at DESC", [userId]).map(
    (row) => row.video_id
  );
  const subscriptions = all("SELECT channel_name FROM subscriptions WHERE user_id = ?", [userId]).map(
    (row) => row.channel_name
  );

  return {
    ...user,
    liked_video_ids: liked,
    history_video_ids: history,
    subscribed_channels: subscriptions,
  };
}

function getSession(req) {
  const cookies = cookie.parse(req.headers.cookie || "");
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;

  const session = get("SELECT * FROM sessions WHERE id = ?", [token]);
  if (!session) return null;

  const expires = new Date(session.expires_at).getTime();
  if (Date.now() > expires) {
    run("DELETE FROM sessions WHERE id = ?", [token], true);
    return null;
  }

  return session;
}

function createSession(userId) {
  const id = crypto.randomUUID();
  const expires = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  run(
    "INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)",
    [id, userId, expires],
    true
  );
  return id;
}

function sessionCookie(token) {
  return cookie.serialize(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000
  });
}

function clearSessionCookie() {
  return cookie.serialize(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    maxAge: 0
  });
}

function sendJson(res, status, obj, extraHeaders = []) {
  const headers = {
    "Content-Type": "application/json",
    ...CORS_HEADERS,
  };
  for (const h of extraHeaders) {
    const [k, v] = h.split(/:(.+)/);
    headers[k] = v;
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(obj));
}

function sendOptions(res) {
  res.writeHead(204, CORS_HEADERS);
  res.end();
}

function isMutationMethod(method) {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  const host = `http://${req.headers.host}`;
  if (origin !== host) throw new Error("Origin mismatch.");
}

function clientIp(req) {
  return req.headers["x-forwarded-for"] || req.socket.remoteAddress || "0.0.0.0";
}

function consumeRateLimit(key, max, windowMs) {
  const now = Date.now();
  const entry = authLimiter.get(key) || { count: 0, reset: now + windowMs };
  if (now > entry.reset) {
    entry.count = 0;
    entry.reset = now + windowMs;
  }
  entry.count++;
  authLimiter.set(key, entry);
  return entry.count <= max;
}

function clearRateLimit(key) {
  authLimiter.delete(key);
}

function toBoolean(v) {
  return v === "1" || v === "true" || v === true;
}
function run(sql, params = [], write = false) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  stmt.step();
  stmt.free();
  if (write) saveDb();
}

function get(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function saveDb() {
  const data = db.export();
  fs.writeFileSync(DB_FILE, Buffer.from(data));
}

function initDb() {
  run(
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE,
      full_name TEXT,
      channel_name TEXT,
      role TEXT,
      password_hash TEXT,
      password_salt TEXT,
      created_at TEXT
    )`
  );

  run(
    `CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      expires_at TEXT
    )`
  );

  run(
    `CREATE TABLE IF NOT EXISTS videos (
      id TEXT PRIMARY KEY,
      title TEXT,
      description TEXT,
      thumbnail_url TEXT,
      video_url TEXT,
      current_frame_url TEXT,
      channel_name TEXT,
      owner_id TEXT,
      category TEXT,
      tags_json TEXT,
      views INTEGER,
      duration TEXT,
      is_live INTEGER,
      is_music INTEGER,
      created_at TEXT
    )`
  );

  run(
    `CREATE TABLE IF NOT EXISTS likes (
      user_id TEXT,
      video_id TEXT
    )`
  );

  run(
    `CREATE TABLE IF NOT EXISTS history (
      user_id TEXT,
      video_id TEXT,
      viewed_at TEXT
    )`
  );

  run(
    `CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      video_id TEXT,
      user_id TEXT,
      email TEXT,
      reason TEXT,
      created_at TEXT
    )`
  );

  run(
    `CREATE TABLE IF NOT EXISTS subscriptions (
      user_id TEXT,
      channel_name TEXT,
      created_at TEXT
    )`
  );

  run(
    `CREATE TABLE IF NOT EXISTS signals (
      id TEXT PRIMARY KEY,
      video_id TEXT,
      payload TEXT,
      created_at TEXT,
      source TEXT
    )`
  );

  ensureSignalSourceColumn();
}

function ensureSignalSourceColumn() {
  const columns = all("PRAGMA table_info(signals)");
  if (!columns.some((col) => col.name === "source")) {
    run("ALTER TABLE signals ADD COLUMN source TEXT");
  }
  run("UPDATE signals SET source = 'broadcaster' WHERE source IS NULL", [], true);
}

function migrateLegacyJsonData() {
  if (fs.existsSync(LEGACY_USERS_FILE)) {
    const users = JSON.parse(fs.readFileSync(LEGACY_USERS_FILE, "utf8"));
    for (const u of users) {
      if (!get("SELECT id FROM users WHERE id = ?", [u.id])) {
        run(
          "INSERT INTO users (id,email,full_name,channel_name,role,password_hash,password_salt,created_at) VALUES (?,?,?,?,?,?,?,?)",
          [
            u.id,
            u.email,
            u.full_name,
            u.channel_name,
            u.role || "user",
            u.password_hash,
            u.password_salt,
            u.created_at || new Date().toISOString()
          ],
          true
        );
      }
    }
    fs.rmSync(LEGACY_USERS_FILE, { force: true });
  }

  if (fs.existsSync(LEGACY_VIDEOS_FILE)) {
    const videos = JSON.parse(fs.readFileSync(LEGACY_VIDEOS_FILE, "utf8"));
    for (const v of videos) {
      if (!get("SELECT id FROM videos WHERE id = ?", [v.id])) {
        run(
          `INSERT INTO videos (
            id,title,description,thumbnail_url,video_url,current_frame_url,
            channel_name,owner_id,category,tags_json,views,duration,
            is_live,is_music,created_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            v.id,
            v.title,
            v.description,
            v.thumbnail_url,
            v.video_url,
            v.current_frame_url || "",
            v.channel_name,
            v.owner_id,
            v.category || "general",
            JSON.stringify(v.tags || []),
            v.views || 0,
            v.duration || "0:00",
            v.is_live ? 1 : 0,
            v.is_music ? 1 : 0,
            v.created_at || new Date().toISOString()
          ],
          true
        );
      }
    }
    fs.rmSync(LEGACY_VIDEOS_FILE, { force: true });
  }
}

function clearExpiredSessions() {
  const now = new Date().toISOString();
  run("DELETE FROM sessions WHERE expires_at < ?", [now], true);
}

function listVideos() {
  const videos = all("SELECT * FROM videos ORDER BY created_at DESC");
  const likes = all("SELECT video_id, COUNT(*) AS count FROM likes GROUP BY video_id");
  const reports = all("SELECT * FROM reports ORDER BY created_at DESC");

  const likesMap = new Map(likes.map((row) => [row.video_id, Number(row.count || 0)]));
  const reportsMap = new Map();
  for (const report of reports) {
    const list = reportsMap.get(report.video_id) || [];
    list.push(report);
    reportsMap.set(report.video_id, list);
  }

  return videos.map((video) => ({
    ...video,
    likes: likesMap.get(video.id) || 0,
    report_count: reportsMap.get(video.id)?.length || 0,
    reports: reportsMap.get(video.id) || [],
    tags: parseTagsJson(video.tags_json),
  }));
}

function getVideoRow(id) {
  return get("SELECT * FROM videos WHERE id = ?", [id]);
}

function getVideoById(id) {
  const v = getVideoRow(id);
  if (!v) return null;
  v.tags = parseTagsJson(v.tags_json);
  return v;
}

function slugFromText(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseTags(str) {
  if (!str) return [];
  return String(str)
    .split(",")
    .map(t => t.trim())
    .filter(Boolean);
}

function parseTagsJson(str) {
  try {
    return JSON.parse(str || "[]");
  } catch {
    return [];
  }
}

function createId(prefix) {
  return prefix + "_" + crypto.randomUUID();
}

function createPasswordHash(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 310000, 32, "sha256").toString("hex");
  return { salt, hash };
}

function verifyPassword(user, password) {
  const hash = crypto.pbkdf2Sync(password, user.password_salt, 310000, 32, "sha256").toString("hex");
  return hash === user.password_hash;
}

async function fetchStocks() {
  const symbols = STOCK_SYMBOLS.join(",");
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols}`;
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = "";
      res.on("data", chunk => (data += chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          resolve(json.quoteResponse.result || []);
        } catch (e) {
          reject(e);
        }
      });
    }).on("error", reject);
  });
}

function isUnderDirectory(filePath, directory) {
  const relative = path.relative(directory, filePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeStaticPath(pathname) {
  const normalized = path.normalize(pathname).replace(/^(\.\.(\/|\\|$))+/g, "");
  return normalized.replace(/^\/+/, "");
}

function serveStatic(req, res, pathname) {
  let targetPath;
  if (pathname === "/" || pathname === "") {
    targetPath = path.join(ROOT, "index.html");
  } else if (pathname.startsWith("/uploads/")) {
    const relative = pathname.replace(/^\/uploads\//, "");
    targetPath = path.join(UPLOADS_DIR, normalizeStaticPath(relative));
  } else {
    targetPath = path.join(ROOT, normalizeStaticPath(pathname));
  }

  const allowedRoot = pathname.startsWith("/uploads/") ? ABS_UPLOADS : ABS_ROOT;
  const resolved = path.resolve(targetPath);
  if (!isUnderDirectory(resolved, allowedRoot)) {
    res.writeHead(403, CORS_HEADERS);
    res.end("Forbidden");
    return;
  }

  fs.stat(resolved, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, CORS_HEADERS);
      res.end("Not found");
      return;
    }

    const ext = path.extname(resolved).toLowerCase();
    const headers = { "Content-Type": MIME_TYPES[ext] || "application/octet-stream", ...CORS_HEADERS };
    res.writeHead(200, headers);
    const stream = fs.createReadStream(resolved);
    stream.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(500, CORS_HEADERS);
      }
      res.end("Server error");
    });
    stream.pipe(res);
  });
}
