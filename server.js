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
const DATA_DIR = path.join(ROOT, "data");
const UPLOADS_DIR = path.join(ROOT, "uploads");
const DB_FILE = path.join(DATA_DIR, "mytube.sqlite");
const LEGACY_USERS_FILE = path.join(DATA_DIR, "users.json");
const LEGACY_VIDEOS_FILE = path.join(DATA_DIR, "videos.json");
const SESSION_COOKIE = "mytube_session";
const STOCK_SYMBOLS = ["AAPL.US", "MSFT.US", "NVDA.US", "TSLA.US", "AMZN.US", "GOOG.US", "META.US", "SPY.US"];
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 1024 * 1024 * 512);
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const ALLOWED_VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime"]);
const AUTH_WINDOW_MS = 1000 * 60 * 15;
const MAX_LOGIN_ATTEMPTS = 10;
const MAX_SIGNUP_ATTEMPTS = 5;
const authLimiter = new Map();

let db;

bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function bootstrap() {
  ensureDirectories();
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(path.dirname(require.resolve("sql.js/dist/sql-wasm.js")), file),
  });

  db = fs.existsSync(DB_FILE) ? new SQL.Database(fs.readFileSync(DB_FILE)) : new SQL.Database();
  initDb();
  migrateLegacyJsonData();
  clearExpiredSessions();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (isMutationMethod(req.method)) {
        assertSameOrigin(req);
      }

      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url);
        return;
      }

      serveStatic(req, res, url.pathname);
    } catch (error) {
      if (error.message === "Request body too large.") {
        sendJson(res, 413, { error: "Upload is too large." });
        return;
      }
      if (error.message === "Origin mismatch.") {
        sendJson(res, 403, { error: "Cross-site request blocked." });
        return;
      }
      sendJson(res, 500, { error: "Internal server error", detail: error.message });
    }
  });

  server.listen(PORT, () => {
    console.log(`MyTube standalone server running at http://localhost:${PORT}`);
  });
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/login") {
    const body = await readJson(req);
    if (!consumeRateLimit(`login:${clientIp(req)}:${String(body.email || "").trim().toLowerCase()}`, MAX_LOGIN_ATTEMPTS, AUTH_WINDOW_MS)) {
      sendJson(res, 429, { error: "Too many login attempts. Please try again later." });
      return;
    }
    const user = get("SELECT * FROM users WHERE lower(email)=lower(?)", [String(body.email || "").trim()]);
    if (!user || !verifyPassword(user, String(body.password || ""))) {
      sendJson(res, 401, { error: "Invalid email or password." });
      return;
    }
    clearRateLimit(`login:${clientIp(req)}:${String(body.email || "").trim().toLowerCase()}`);
    const token = createSession(user.id);
    sendJson(res, 200, { user: publicUser(user.id) }, [sessionCookie(token)]);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/logout") {
    const session = getSession(req);
    if (session) {
      run("DELETE FROM sessions WHERE id = ?", [session.id], true);
    }
    sendJson(res, 200, { ok: true }, [clearSessionCookie()]);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/signup") {
    const body = await readJson(req);
    if (!consumeRateLimit(`signup:${clientIp(req)}`, MAX_SIGNUP_ATTEMPTS, AUTH_WINDOW_MS)) {
      sendJson(res, 429, { error: "Too many signup attempts. Please try again later." });
      return;
    }
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const fullName = String(body.full_name || "").trim();
    const channelName = slugFromText(body.channel_name || fullName || email.split("@")[0]);

    if (!email || !password || !fullName) {
      sendJson(res, 400, { error: "Name, email, and password are required." });
      return;
    }
    if (password.length < 8) {
      sendJson(res, 400, { error: "Password must be at least 8 characters." });
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      sendJson(res, 400, { error: "Please enter a valid email address." });
      return;
    }
    if (get("SELECT id FROM users WHERE lower(email)=lower(?)", [email])) {
      sendJson(res, 409, { error: "An account with that email already exists." });
      return;
    }

    const userId = createId("user");
    const passwordData = createPasswordHash(password);
    run(
      "INSERT INTO users (id, email, full_name, channel_name, role, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, 'user', ?, ?, ?)",
      [userId, email, fullName, channelName, passwordData.hash, passwordData.salt, new Date().toISOString()],
      true,
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
      sendJson(res, 502, { error: "Could not fetch live stock quotes." });
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
        id, title, description, thumbnail_url, video_url, current_frame_url, channel_name, owner_id,
        category, tags_json, views, duration, is_live, is_music, created_at
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
        new Date().toISOString(),
      ],
      true,
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
          // Delete files from uploads
    const thumbPath = path.join(UPLOADS_DIR, path.basename(video.thumbnail_url));
    const videoPath = path.join(UPLOADS_DIR, path.basename(video.video_url));

    fs.rm(thumbPath, { force: true }, () => {});
    fs.rm(videoPath, { force: true }, () => {});

    // Delete DB rows
    run("DELETE FROM likes WHERE video_id = ?", [videoId]);
    run("DELETE FROM history WHERE video_id = ?", [videoId]);
    run("DELETE FROM reports WHERE video_id = ?", [videoId]);
    run("DELETE FROM videos WHERE id = ?", [videoId], true);

    sendJson(res, 200, { ok: true });
    return;

    }

    if (req.method === "POST" && parts[3] === "toggle-like") {
      const user = requireUser(req, res);
      if (!user) return;
      if (!getVideoRow(videoId)) {
        sendJson(res, 404, { error: "Video not found." });
        return;
      }
      const existing = get("SELECT 1 AS ok FROM likes WHERE user_id = ? AND video_id = ?", [user.id, videoId]);
      if (existing) {
        run("DELETE FROM likes WHERE user_id = ? AND video_id = ?", [user.id, videoId], true);
      } else {
        run("INSERT INTO likes (user_id, video_id, created_at) VALUES (?, ?, ?)", [user.id, videoId, new Date().toISOString()], true);
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
      run("INSERT INTO history (user_id, video_id, viewed_at) VALUES (?, ?, ?)", [user.id, videoId, new Date().toISOString()], true);
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
      const existing = get("SELECT 1 AS ok FROM reports WHERE user_id = ? AND video_id = ?", [user.id, videoId]);
      if (!existing) {
        run(
          "INSERT INTO reports (id, video_id, user_id, email, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          [createId("report"), videoId, user.id, user.email, String(body.reason || "Inappropriate content").trim(), new Date().toISOString()],
          true,
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
        true,
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
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  if (parts[1] === "channels" && parts[2] && req.method === "POST" && parts[3] === "subscribe") {
    const user = requireUser(req, res);
    if (!user) return;
    const channelName = decodeURIComponent(parts[2]);
    if (channelName === user.channel_name) {
      sendJson(res, 400, { error: "You cannot subscribe to your own channel." });
      return;
    }
    const existing = get("SELECT 1 AS ok FROM subscriptions WHERE user_id = ? AND channel_name = ?", [user.id, channelName]);
    if (existing) {
      run("DELETE FROM subscriptions WHERE user_id = ? AND channel_name = ?", [user.id, channelName], true);
    } else {
      run("INSERT INTO subscriptions (user_id, channel_name, created_at) VALUES (?, ?, ?)", [user.id, channelName, new Date().toISOString()], true);
    }
    sendJson(res, 200, { subscribed: !existing });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/reports") {
    const user = requireUser(req, res);
    if (!user) return;
    if (user.role !== "admin") {
      sendJson(res, 403, { error: "Admin access required." });
      return;
    }
    sendJson(res, 200, { videos: listVideos().filter((video) => video.report_count > 0).sort((a, b) => b.report_count - a.report_count) });
    return;
  }

  sendJson(res, 404, { error: "Not found." });
}

function initDb() {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      full_name TEXT NOT NULL,
      channel_name TEXT NOT NULL,
      role TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS videos (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      thumbnail_url TEXT NOT NULL DEFAULT '',
      video_url TEXT NOT NULL DEFAULT '',
      current_frame_url TEXT NOT NULL DEFAULT '',
      channel_name TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      category TEXT NOT NULL,
      tags_json TEXT NOT NULL DEFAULT '[]',
      views INTEGER NOT NULL DEFAULT 0,
      duration TEXT NOT NULL DEFAULT '0:00',
      is_live INTEGER NOT NULL DEFAULT 0,
      is_music INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS likes (
      user_id TEXT NOT NULL,
      video_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, video_id)
    );
    CREATE TABLE IF NOT EXISTS history (
      user_id TEXT NOT NULL,
      video_id TEXT NOT NULL,
      viewed_at TEXT NOT NULL,
      PRIMARY KEY (user_id, video_id)
    );
    CREATE TABLE IF NOT EXISTS subscriptions (
      user_id TEXT NOT NULL,
      channel_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, channel_name)
    );
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      video_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      email TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  persistDb();
}

function migrateLegacyJsonData() {
  const existing = get("SELECT COUNT(*) AS count FROM users");
  if (existing && existing.count > 0) return;

  const users = readJsonFile(LEGACY_USERS_FILE, []);
  const videos = readJsonFile(LEGACY_VIDEOS_FILE, []);

  for (const user of users) {
    const passwordData =
      user.password_hash && user.password_salt
        ? { hash: user.password_hash, salt: user.password_salt }
        : createPasswordHash(user.password || crypto.randomBytes(8).toString("hex"));
    run(
      "INSERT INTO users (id, email, full_name, channel_name, role, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        user.id || createId("user"),
        user.email,
        user.full_name || "User",
        user.channel_name || slugFromText(user.full_name || user.email),
        user.role || "user",
        passwordData.hash,
        passwordData.salt,
        user.created_at || new Date().toISOString(),
      ],
    );
  }

  for (const video of videos) {
    run(
      `INSERT INTO videos (
        id, title, description, thumbnail_url, video_url, current_frame_url, channel_name, owner_id,
        category, tags_json, views, duration, is_live, is_music, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        video.id || createId("video"),
        video.title || "Untitled video",
        video.description || "",
        video.thumbnail_url || "",
        video.video_url || "",
        video.current_frame_url || "",
        video.channel_name || "channel",
        video.owner_id || (users[0] && users[0].id) || createId("user"),
        video.category || "general",
        JSON.stringify(video.tags || []),
        Number(video.views || 0),
        video.duration || "0:00",
        video.is_live ? 1 : 0,
        video.is_music ? 1 : 0,
        video.created_at || new Date().toISOString(),
      ],
    );

    for (const report of video.reports || []) {
      run(
        "INSERT INTO reports (id, video_id, user_id, email, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [createId("report"), video.id, report.user_id || users[0].id, report.email || "", report.reason || "Reported content", report.created_at || new Date().toISOString()],
      );
    }
  }

  for (const user of users) {
    for (const likedId of user.liked_video_ids || []) {
      run("INSERT OR IGNORE INTO likes (user_id, video_id, created_at) VALUES (?, ?, ?)", [user.id, likedId, new Date().toISOString()]);
    }
    for (const historyId of user.history_video_ids || []) {
      run("INSERT OR IGNORE INTO history (user_id, video_id, viewed_at) VALUES (?, ?, ?)", [user.id, historyId, new Date().toISOString()]);
    }
    for (const channel of user.subscribed_channels || []) {
      run("INSERT OR IGNORE INTO subscriptions (user_id, channel_name, created_at) VALUES (?, ?, ?)", [user.id, channel, new Date().toISOString()]);
    }
  }

  persistDb();
}

function requireUser(req, res) {
  const session = getSession(req);
  if (!session) {
    sendJson(res, 401, { error: "Unauthorized" });
    return null;
  }
  const user = get("SELECT * FROM users WHERE id = ?", [session.user_id]);
  if (!user) {
    run("DELETE FROM sessions WHERE id = ?", [session.id], true);
    sendJson(res, 401, { error: "Unauthorized" });
    return null;
  }
  return user;
}

function getSession(req) {
  const cookies = cookie.parse(req.headers.cookie || "");
  const rawToken = cookies[SESSION_COOKIE];
  if (!rawToken) return null;
  const session = get("SELECT * FROM sessions WHERE token_hash = ?", [hashToken(rawToken)]);
  if (!session) return null;
  if (Number(session.expires_at) <= Date.now()) {
    run("DELETE FROM sessions WHERE id = ?", [session.id], true);
    return null;
  }
  return session;
}

function createSession(userId) {
  const rawToken = crypto.randomBytes(32).toString("hex");
  run("DELETE FROM sessions WHERE user_id = ?", [userId]);
  run(
    "INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
    [createId("session"), userId, hashToken(rawToken), Date.now() + SESSION_TTL_MS, new Date().toISOString()],
    true,
  );
  return rawToken;
}

function publicUser(userId) {
  const user = typeof userId === "string" ? get("SELECT * FROM users WHERE id = ?", [userId]) : userId;
  return {
    id: user.id,
    email: user.email,
    full_name: user.full_name,
    channel_name: user.channel_name,
    role: user.role,
    liked_video_ids: all("SELECT video_id FROM likes WHERE user_id = ? ORDER BY created_at DESC", [user.id]).map((row) => row.video_id),
    history_video_ids: all("SELECT video_id FROM history WHERE user_id = ? ORDER BY viewed_at DESC", [user.id]).map((row) => row.video_id),
    subscribed_channels: all("SELECT channel_name FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC", [user.id]).map((row) => row.channel_name),
  };
}

function listVideos() {
  return all("SELECT * FROM videos ORDER BY created_at DESC").map(enrichVideo);
}

function getVideoRow(videoId) {
  return get("SELECT * FROM videos WHERE id = ?", [videoId]);
}

function getVideoById(videoId) {
  const video = getVideoRow(videoId);
  return video ? enrichVideo(video) : null;
}

function enrichVideo(video) {
  return {
    ...video,
    tags: parseTagsJson(video.tags_json),
    likes: get("SELECT COUNT(*) AS count FROM likes WHERE video_id = ?", [video.id]).count,
    report_count: get("SELECT COUNT(*) AS count FROM reports WHERE video_id = ?", [video.id]).count,
    reports: all("SELECT user_id, email, reason, created_at FROM reports WHERE video_id = ? ORDER BY created_at DESC", [video.id]),
    is_live: Boolean(Number(video.is_live)),
    is_music: Boolean(Number(video.is_music)),
  };
}

function run(sql, params = [], persist = false) {
  db.run(sql, params);
  if (persist) persistDb();
}

function get(sql, params = []) {
  const statement = db.prepare(sql, params);
  if (!statement.step()) {
    statement.free();
    return null;
  }
  const row = statement.getAsObject();
  statement.free();
  return row;
}

function all(sql, params = []) {
  const statement = db.prepare(sql, params);
  const rows = [];
  while (statement.step()) {
    rows.push(statement.getAsObject());
  }
  statement.free();
  return rows;
}

function persistDb() {
  fs.writeFileSync(DB_FILE, Buffer.from(db.export()));
}

function serveStatic(req, res, pathname) {
  const cleanPath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const targetPath = path.resolve(ROOT, cleanPath);
  if (!isPathInside(ROOT, targetPath)) {
    sendText(res, 403, "Forbidden");
    return;
  }
  const pathExists = fs.existsSync(targetPath) && !fs.statSync(targetPath).isDirectory();
  if (!pathExists && (pathname.startsWith("/uploads/") || pathname.startsWith("/assets/") || path.extname(pathname))) {
    sendText(res, 404, "Not found");
    return;
  }
  const finalPath = pathExists ? targetPath : path.join(ROOT, "index.html");
  sendFile(res, finalPath, req);
}

function sendFile(res, filePath, req) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
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
    ".mov": "video/quicktime",
  }[ext] || "application/octet-stream";

  const stat = fs.statSync(filePath);
  if ([".mp4", ".webm", ".mov"].includes(ext) && req && req.headers.range) {
    sendRangeFile(res, filePath, stat, contentType, req.headers.range);
    return;
  }

  res.writeHead(200, {
    ...securityHeaders(),
    "Content-Type": contentType,
    "Cache-Control": filePath.includes(`${path.sep}uploads${path.sep}`) ? "private, max-age=31536000, immutable" : "no-cache",
    "Content-Length": stat.size,
    "Accept-Ranges": "bytes",
  });
  fs.createReadStream(filePath).pipe(res);
}

function sendRangeFile(res, filePath, stat, contentType, rangeHeader) {
  const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader || "");
  if (!match) {
    res.writeHead(416, { ...securityHeaders(), "Content-Range": `bytes */${stat.size}` });
    res.end();
    return;
  }

  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Number(match[2]) : stat.size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end >= stat.size || start > end) {
    res.writeHead(416, { ...securityHeaders(), "Content-Range": `bytes */${stat.size}` });
    res.end();
    return;
  }

  res.writeHead(206, {
    ...securityHeaders(),
    "Content-Type": contentType,
    "Cache-Control": "private, max-age=31536000, immutable",
    "Accept-Ranges": "bytes",
    "Content-Length": end - start + 1,
    "Content-Range": `bytes ${start}-${end}/${stat.size}`,
  });
  fs.createReadStream(filePath, { start, end }).pipe(res);
}

function sendJson(res, statusCode, payload, cookiesToSet = []) {
  const headers = {
    ...securityHeaders(),
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache",
  };
  if (cookiesToSet.length) headers["Set-Cookie"] = cookiesToSet;
  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { ...securityHeaders(), "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_JSON_BYTES) {
      throw new Error("Request body too large.");
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const fields = {};
    const files = {};
    const pendingWrites = [];
    let settled = false;
    const busboy = Busboy({
      headers: req.headers,
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 2, fields: 20 },
    });

    function fail(error) {
      if (settled) return;
      settled = true;
      Promise.all(
        Object.values(files).map((entry) =>
          fs.promises.rm(entry.filePath, { force: true }).catch(() => {}),
        ),
      ).finally(() => reject(error));
    }

    busboy.on("field", (name, value) => {
      fields[name] = value;
    });
    busboy.on("file", (name, file, info) => {
      const allowedTypes = name === "thumbnail_file" ? ALLOWED_IMAGE_TYPES : name === "video_file" ? ALLOWED_VIDEO_TYPES : null;
      if (!allowedTypes) {
        file.resume();
        return;
      }
      if (!allowedTypes.has(info.mimeType)) {
        file.resume();
        fail(new Error(`Unsupported ${name === "thumbnail_file" ? "image" : "video"} type.`));
        return;
      }
      const ext = safeExtension(info.mimeType, info.filename);
      const fileName = `${name}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}.${ext}`;
      const filePath = path.join(UPLOADS_DIR, fileName);
      const stream = fs.createWriteStream(filePath);
      const writeDone = new Promise((resolveWrite, rejectWrite) => {
        stream.on("finish", resolveWrite);
        stream.on("error", rejectWrite);
      });
      pendingWrites.push(writeDone);
      file.on("limit", () => {
        stream.destroy();
        fail(new Error("Upload is too large."));
      });
      file.on("error", fail);
      stream.on("error", fail);
      file.pipe(stream);
      files[name] = { fileName, filePath, mimeType: info.mimeType };
    });
    busboy.on("partsLimit", () => fail(new Error("Too many uploaded fields.")));
    busboy.on("filesLimit", () => fail(new Error("Too many files uploaded.")));
    busboy.on("fieldsLimit", () => fail(new Error("Too many form fields.")));
    busboy.on("error", fail);
    busboy.on("finish", async () => {
      if (settled) return;
      try {
        await Promise.all(pendingWrites);
        settled = true;
        resolve({ fields, files });
      } catch (error) {
        fail(error);
      }
    });
    req.pipe(busboy);
  });
}

function safeExtension(mimeType, originalName) {
  const byMime = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
  };
  if (byMime[mimeType]) return byMime[mimeType];
  return path.extname(originalName || "").replace(".", "").toLowerCase() || "bin";
}

function createPasswordHash(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { hash, salt };
}

function verifyPassword(user, password) {
  const hash = crypto.scryptSync(password, user.password_salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(user.password_hash, "hex"));
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function sessionCookie(token) {
  return cookie.serialize(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

function clearSessionCookie() {
  return cookie.serialize(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
}

function securityHeaders() {
  const headers = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "SAMEORIGIN",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(self), microphone=(self), geolocation=(), payment=(), usb=()",
    "Content-Security-Policy":
      "default-src 'self'; img-src 'self' data: blob: https:; media-src 'self' blob:; connect-src 'self' https://stooq.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; script-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'; object-src 'none'",
  };
  if (process.env.NODE_ENV === "production") {
    headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  }
  return headers;
}

function isMutationMethod(method) {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(method); //67
}

function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "http";
  const expected = `${proto}://${host}`;
  if (origin !== expected) throw new Error("Origin mismatch.");
}

function ensureDirectories() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

function isPathInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return candidatePath === rootPath || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function slugFromText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || `channel-${crypto.randomBytes(3).toString("hex")}`;
}

function createId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function removeUploadedFiles(files) {
  for (const entry of Object.values(files || {})) {
    if (entry && entry.filePath) {
      fs.rmSync(entry.filePath, { force: true });
    }
  }
}

function clearExpiredSessions() {
  run("DELETE FROM sessions WHERE expires_at <= ?", [Date.now()], true);
}

function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket.remoteAddress || "local";
}

function consumeRateLimit(key, limit, windowMs) {
  const now = Date.now();
  const record = authLimiter.get(key);
  if (!record || record.resetAt <= now) {
    authLimiter.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (record.count >= limit) {
    return false;
  }
  record.count += 1;
  authLimiter.set(key, record);
  return true;
}

function clearRateLimit(key) {
  authLimiter.delete(key);
}

function parseTags(raw) {
  return String(raw || "").split(",").map((tag) => tag.trim()).filter(Boolean);
}

function parseTagsJson(raw) {
  try {
    return JSON.parse(raw || "[]");
  } catch {
    return [];
  }
}

function toBoolean(value) {
  return value === true || value === "true" || value === "on" || value === "1";
}

async function fetchStocks() {
  const quotes = await Promise.all(STOCK_SYMBOLS.map(fetchStockFromStooq));
  return quotes.filter(Boolean);
}

async function fetchStockFromStooq(symbol) {
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(symbol.toLowerCase())}&f=sd2t2ohlcvn&e=json`;
  const payload = await getJson(url);
  const entry = ((payload || {}).symbols || [])[0];
  if (!entry) return null;
  const price = Number(entry.close || 0);
  const open = Number(entry.open || 0);
  const change = price - open;
  const changePercent = open ? (change / open) * 100 : 0;
  return {
    symbol: String(entry.symbol || symbol).replace(".US", ""),
    shortName: entry.name || symbol.replace(".US", ""),
    price,
    change,
    changePercent,
    marketState: "DELAYED",
  };
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "MyTube-Standalone/1.0" } }, (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`Request failed with status ${response.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      })
      .on("error", reject);
  });
}
