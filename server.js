const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const Busboy = require("busboy");
const cookie = require("cookie");

const PORT = Number(process.env.PORT || 3000);
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 1000 * 60 * 60 * 24 * 7);
const MAX_JSON_BYTES = Number(process.env.MAX_REQUEST_BYTES || 1024 * 1024 * 10);
const ROOT = __dirname;
const ABS_ROOT = path.resolve(ROOT);
const STORAGE_ROOT = path.resolve(process.env.STORAGE_ROOT || ROOT);
const UPLOADS_DIR = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : path.join(STORAGE_ROOT, "uploads");
const ABS_UPLOADS = path.resolve(UPLOADS_DIR);
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(STORAGE_ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "mytube-data.json");
const SQLITE_EXPORT_FILE = path.join(DATA_DIR, "sqlite-json", "all-tables.json");
const LEGACY_USERS_FILE = path.join(DATA_DIR, "users.json");
const LEGACY_VIDEOS_FILE = path.join(DATA_DIR, "videos.json");
const SESSION_COOKIE = "mytube_session";
const STOCK_SYMBOLS = ["AAPL","MSFT","NVDA","TSLA","AMZN","GOOG","META","SPY"];
const STOCK_FALLBACKS = [
  { symbol: "AAPL", shortName: "Apple", price: 212.4, change: 1.82, changePercent: 0.86, marketState: "CACHED" },
  { symbol: "MSFT", shortName: "Microsoft", price: 428.15, change: 2.11, changePercent: 0.5, marketState: "CACHED" },
  { symbol: "NVDA", shortName: "NVIDIA", price: 118.72, change: -1.24, changePercent: -1.03, marketState: "CACHED" },
  { symbol: "TSLA", shortName: "Tesla", price: 171.34, change: -3.92, changePercent: -2.24, marketState: "CACHED" },
  { symbol: "AMZN", shortName: "Amazon", price: 186.09, change: 0.94, changePercent: 0.51, marketState: "CACHED" },
  { symbol: "GOOG", shortName: "Alphabet", price: 162.27, change: 0.72, changePercent: 0.45, marketState: "CACHED" },
  { symbol: "META", shortName: "Meta", price: 503.88, change: 4.17, changePercent: 0.83, marketState: "CACHED" },
  { symbol: "SPY", shortName: "SPDR S&P 500 ETF", price: 512.66, change: 1.4, changePercent: 0.27, marketState: "CACHED" },
];
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 1024 * 1024 * 512);
const ALLOWED_IMAGE_TYPES = new Set(["image/png","image/jpeg","image/webp","image/gif"]);
const ALLOWED_VIDEO_TYPES = new Set(["video/mp4","video/webm","video/quicktime","audio/mpeg","audio/mp3"]);
const AUTH_WINDOW_MS = 1000 * 60 * 15;
const MAX_LOGIN_ATTEMPTS = 10;
const MAX_SIGNUP_ATTEMPTS = 5;
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
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".ico": "image/x-icon",
};

function buildCorsHeaders(req) {
  const origin = req && req.headers && (req.headers.origin || req.headers.referer);
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Credentials": "true",
  };
}
const authLimiter = new Map();
const liveChatStreams = new Map();
const viewerCounts = new Map();
const MAX_CHAT_STREAM_HISTORY = 200;
function ensureDirectories() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

function logStorageConfiguration() {
  console.log(`[storage] root=${STORAGE_ROOT}`);
  console.log(`[storage] data=${DATA_DIR}`);
  console.log(`[storage] uploads=${UPLOADS_DIR}`);
  if (process.env.RENDER && STORAGE_ROOT === ABS_ROOT) {
    console.warn(
      "[storage] Render is using the app directory for storage. Uploads and JSON data will be lost on deploy unless you set STORAGE_ROOT, DATA_DIR, or UPLOADS_DIR to a persistent disk mount path."
    );
  }
}

let db;

bootstrap().catch(err => {
  console.error(err);
  process.exit(1);
});

async function bootstrap() {
  ensureDirectories();
  logStorageConfiguration();
  db = loadDataStore();
  ensureDefaultStocks();
  migrateLegacyJsonData();
  ensureAdminUsers();
  clearExpiredSessions();
  persistLegacyUsers();
  persistLegacyVideos();

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
      if (err.message === "Unsupported media format." || err.message === "Unsupported thumbnail format.") {
        sendJson(res, 400, { error: err.message });
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
    sendOptions(res, req);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/login") {
    const body = await readJson(req);
    if (!consumeRateLimit(`login:${clientIp(req)}:${String(body.email||"").toLowerCase()}`, MAX_LOGIN_ATTEMPTS, AUTH_WINDOW_MS)) {
      sendJson(res, 429, { error: "Too many login attempts." });
      return;
    }
    const user = findUserByEmail(String(body.email || "").trim());
    if (!user || !verifyPassword(user, String(body.password||""))) {
      sendJson(res, 401, { error: "Invalid email or password." });
      return;
    }
    clearRateLimit(`login:${clientIp(req)}:${String(body.email||"").toLowerCase()}`);
    const token = createSession(user.id);
    sendJson(res, 200, { user: publicUser(user.id) }, [setCookieHeader(sessionCookie(token))]);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/logout") {
    const session = getSession(req);
    if (session) {
      db.sessions = db.sessions.filter((entry) => entry.id !== session.id);
      persistDataStore();
    }
    sendJson(res, 200, { ok: true }, [setCookieHeader(clearSessionCookie())]);
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
    if (findUserByEmail(email)) {
      sendJson(res, 409, { error: "Email already exists." });
      return;
    }

    const userId = createId("user");
    const pass = createPasswordHash(password);

    db.users.push({
      id: userId,
      email,
      full_name: fullName,
      channel_name: channelName,
      role: "user",
      password_hash: pass.hash,
      password_salt: pass.salt,
      created_at: new Date().toISOString(),
    });
    persistDataStore();

    persistLegacyUsers();

    const token = createSession(userId);
    sendJson(res, 201, { user: publicUser(userId) }, [setCookieHeader(sessionCookie(token))]);
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

  if (req.method === "GET" && url.pathname === "/api/videos/live-viewers") {
    const user = requireUser(req, res);
    if (!user) return;
    sendJson(res, 200, { counts: getLiveViewerCounts() });
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

    db.videos.push({
      id: videoId,
      title,
      description: String(fields.description || "").trim(),
      thumbnail_url: files.thumbnail_file ? `/uploads/${files.thumbnail_file.fileName}` : "",
      video_url: files.video_file ? `/uploads/${files.video_file.fileName}` : "",
      current_frame_url: "",
      channel_name: user.channel_name,
      owner_id: user.id,
      category: String(fields.category || "general").trim() || "general",
      tags_json: JSON.stringify(parseTags(fields.tags)),
      views: 0,
      duration: String(fields.duration || "0:00").trim() || "0:00",
      is_live: isLive,
      is_music: toBoolean(fields.is_music),
      created_at: new Date().toISOString(),
    });
    persistDataStore();

    persistLegacyVideos();
    sendJson(res, 201, { video: getVideoById(videoId) });
    return;
  }
  if (parts[1] === "videos" && parts[2]) {
    const videoId = parts[2];

    if (parts[3] === "chat") {
      if (parts[4] === "stream" && req.method === "GET") {
        const user = requireUser(req, res);
        if (!user) return;
        const video = getVideoRow(videoId);
        if (!video) {
          sendJson(res, 404, { error: "Video not found." });
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          ...buildCorsHeaders(req),
        });
        res.write("retry: 10000\n\n");
        const cleanup = registerLiveChatClient(videoId, res);
        let closed = false;
        const onClose = () => {
          if (closed) return;
          closed = true;
          cleanup();
          res.end();
        };
        req.on("close", onClose);
        req.on("end", onClose);
        return;
      }

      if (req.method === "GET") {
        const video = getVideoRow(videoId);
        if (!video) {
          sendJson(res, 404, { error: "Video not found." });
          return;
        }
        const messages = listLiveChatMessages(videoId);
        sendJson(res, 200, { messages });
        return;
      }

      if (req.method === "POST") {
        const user = requireUser(req, res);
        if (!user) return;
        const video = getVideoRow(videoId);
        if (!video) {
          sendJson(res, 404, { error: "Video not found." });
          return;
        }
        const body = await readJson(req);
        const message = String(body.message || "").trim();
        if (!message) {
          sendJson(res, 400, { error: "Message is required." });
          return;
        }
        const record = insertLiveChatMessage(videoId, user.id, message);
        const payload = formatChatPayload(record);
        broadcastToLiveChat(videoId, "chat", payload);
        sendJson(res, 201, { message: payload });
        return;
      }
    }

    if (parts[3] === "comments") {
      if (req.method === "GET" && parts.length === 4) {
        const comments = listCommentsForVideo(videoId);
        sendJson(res, 200, { comments });
        return;
      }
      if (req.method === "POST") {
        const user = requireUser(req, res);
        if (!user) return;
        const video = getVideoRow(videoId);
        if (!video) {
          sendJson(res, 404, { error: "Video not found." });
          return;
        }
        const body = await readJson(req);
        const content = String(body.content || "").trim();
        if (!content) {
          sendJson(res, 400, { error: "Content is required." });
          return;
        }
        const comment = insertComment(videoId, user.id, content);
        sendJson(res, 201, { comment });
        return;
      }
      if (req.method === "DELETE" && parts[4]) {
        const user = requireUser(req, res);
        if (!user) return;
        const comment = db.comments.find((entry) => entry.id === parts[4] && entry.video_id === videoId) || null;
        if (!comment) {
          sendJson(res, 404, { error: "Comment not found." });
          return;
        }
        if (comment.user_id !== user.id && user.role !== "admin") {
          sendJson(res, 403, { error: "You cannot delete this comment." });
          return;
        }
        deleteComment(videoId, parts[4]);
        sendJson(res, 200, { ok: true });
        return;
      }
    }

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

      db.likes = db.likes.filter((entry) => entry.video_id !== videoId);
      db.history = db.history.filter((entry) => entry.video_id !== videoId);
      db.reports = db.reports.filter((entry) => entry.video_id !== videoId);
      db.comments = db.comments.filter((entry) => entry.video_id !== videoId);
      db.live_chat_messages = db.live_chat_messages.filter((entry) => entry.video_id !== videoId);
      db.signals = db.signals.filter((entry) => entry.video_id !== videoId);
      db.videos = db.videos.filter((entry) => entry.id !== videoId);
      persistDataStore();
      persistLegacyVideos();
      liveChatStreams.delete(videoId);
      viewerCounts.delete(videoId);
      broadcastViewerCount(videoId);

      sendJson(res, 200, { ok: true });
      return;
    }

    if (parts[3] === "signal") {
      if (req.method === "POST") {
        const body = await readJson(req);
        const type = String(body.type || "").trim();
        const validTypes = new Set(["offer", "answer", "candidate", "viewer-ready", "viewer-left"]);
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
        if (body.peer_id) {
          payload.peer_id = String(body.peer_id).trim();
        }

        const source = body.source === "viewer" ? "viewer" : "broadcaster";
        db.signals.push({
          id: crypto.randomUUID(),
          video_id: videoId,
          payload: JSON.stringify(payload),
          created_at: new Date().toISOString(),
          source,
        });
        persistDataStore();
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "GET") {
        const role = String(url.searchParams.get("for") || "viewer").toLowerCase();
        const desiredSource = role === "broadcaster" ? "viewer" : "broadcaster";
        const peerId = String(url.searchParams.get("peer_id") || "").trim();
        const rows = db.signals
          .filter((row) => row.video_id === videoId && row.source === desiredSource)
          .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
        const signals = [];
        const idsToDelete = [];
        for (const row of rows) {
          try {
            const payload = JSON.parse(row.payload);
            if (role === "viewer" && payload.peer_id && peerId && payload.peer_id !== peerId) {
              continue;
            }
            if (role === "viewer" && payload.peer_id && !peerId) {
              continue;
            }
            signals.push(payload);
            idsToDelete.push(row.id);
          } catch {
            // Skip malformed payloads.
          }
        }
        if (idsToDelete.length) {
          db.signals = db.signals.filter((row) => !idsToDelete.includes(row.id));
          persistDataStore();
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
      const existing = db.likes.find((row) => row.user_id === user.id && row.video_id === videoId);
      if (existing) {
        db.likes = db.likes.filter((row) => !(row.user_id === user.id && row.video_id === videoId));
      } else {
        db.likes.push({
          user_id: user.id,
          video_id: videoId,
          created_at: new Date().toISOString(),
        });
      }
      persistDataStore();
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
      const currentVideo = getVideoRow(videoId);
      currentVideo.views = Number(currentVideo.views || 0) + 1;
      db.history = db.history.filter((entry) => !(entry.user_id === user.id && entry.video_id === videoId));
      db.history.push({
        user_id: user.id,
        video_id: videoId,
        viewed_at: new Date().toISOString(),
      });
      persistDataStore();
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
      const existing = db.reports.find((row) => row.user_id === user.id && row.video_id === videoId);
      if (!existing) {
        db.reports.push({
          id: createId("report"),
          video_id: videoId,
          user_id: user.id,
          email: user.email,
          reason: String(body.reason || "Inappropriate content").trim(),
          created_at: new Date().toISOString(),
        });
        persistDataStore();
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
      video.current_frame_url = frame;
      if (!video.thumbnail_url) {
        video.thumbnail_url = frame;
      }
      persistDataStore();
      persistLegacyVideos();
      broadcastToLiveChat(videoId, "frame", { videoId, frame });
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
      video.is_live = false;
      db.signals = db.signals.filter((entry) => entry.video_id !== videoId);
      persistDataStore();
      persistLegacyVideos();
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

    const existing = db.subscriptions.find((entry) => entry.user_id === user.id && entry.channel_name === channelName);

    if (existing) {
      db.subscriptions = db.subscriptions.filter((entry) => !(entry.user_id === user.id && entry.channel_name === channelName));
      persistDataStore();
      sendJson(res, 200, { subscribed: false });
      return;
    }

    db.subscriptions.push({
      user_id: user.id,
      channel_name: channelName,
      created_at: new Date().toISOString(),
    });
    persistDataStore();

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

  if (req.method === "POST" && url.pathname === "/api/stocks/mytube") {
    const user = requireUser(req, res);
    if (!user) return;
    if (user.role !== "admin") {
      sendJson(res, 403, { error: "Admin access required." });
      return;
    }
    const body = await readJson(req);
    const price = Number(body.price);
    const change = Number(body.change);
    const changePercent = Number(body.changePercent ?? body.change_percent ?? 0);
    const trendMode = normalizeTrendMode(body.trendMode ?? body.trend_mode);
    if (Number.isNaN(price) || Number.isNaN(change) || Number.isNaN(changePercent)) {
      sendJson(res, 400, { error: "Invalid stock values." });
      return;
    }
    updateMyTubeStock({ price, change, changePercent, trendMode });
    sendJson(res, 200, { ok: true });
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
      const extension = path.extname(filename || "").toLowerCase();
      const isThumbnail = name === "thumbnail_file";
      const isMedia = name === "video_file";
      const mediaLooksValid = isMedia && (ALLOWED_VIDEO_TYPES.has(mimeType) || [".mp4", ".webm", ".mov", ".mp3"].includes(extension));
      const imageLooksValid = isThumbnail && (ALLOWED_IMAGE_TYPES.has(mimeType) || [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extension));

      if ((isThumbnail && !imageLooksValid) || (isMedia && !mediaLooksValid)) {
        file.resume();
        reject(new Error(isThumbnail ? "Unsupported thumbnail format." : "Unsupported media format."));
        return;
      }

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
  const user = findUserById(session.user_id);
  if (!user) {
    sendJson(res, 401, { error: "Invalid session." });
    return null;
  }
  return user;
}

function publicUser(userId) {
  return publicUserFields(findUserById(userId));
}

function getSession(req) {
  const cookies = cookie.parse(req.headers.cookie || "");
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;

  const session = findSessionByToken(token);
  if (!session) return null;

  const expires = sessionExpiresAt(session.expires_at);
  if (Date.now() > expires) {
    db.sessions = db.sessions.filter((entry) => entry.id !== session.id);
    persistDataStore();
    return null;
  }

  return session;
}

function createSession(userId) {
  const token = crypto.randomUUID();
  db.sessions.push({
    id: createId("session"),
    user_id: userId,
    token_hash: hashSessionToken(token),
    expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    created_at: new Date().toISOString(),
  });
  persistDataStore();

  return token;
}

function sessionCookie(token) {
  return cookie.serialize(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

function clearSessionCookie() {
  return cookie.serialize(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
}

function setCookieHeader(value) {
  return { key: "Set-Cookie", value };
}

function sendJson(res, status, obj, extraHeaders = []) {
  const headers = {
    "Content-Type": "application/json",
    ...buildCorsHeaders(res.req),
  };
  for (const header of extraHeaders) {
    if (!header) continue;
    if (typeof header === "string") {
      const [k, v] = header.split(/:(.+)/);
      if (k && typeof v !== "undefined") {
        headers[k] = v;
      }
      continue;
    }
    if (header && header.key) {
      headers[header.key] = header.value;
    }
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(obj));
}

function sendOptions(res, req) {
  res.writeHead(204, buildCorsHeaders(req));
  res.end();
}

function isMutationMethod(method) {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  try {
    const originUrl = new URL(origin);
    const hostHeader = String(req.headers.host || "");
    const headerHost = hostHeader.split(":")[0];
    if (originUrl.hostname !== headerHost) {
      throw new Error("Origin mismatch.");
    }
  } catch {
    throw new Error("Origin mismatch.");
  }
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

function hashSessionToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function sessionExpiresAt(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function toBoolean(v) {
  return v === "1" || v === "true" || v === true;
}

function saveDb() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2) + "\n");
}

function createEmptyDataStore() {
  return {
    users: [],
    sessions: [],
    videos: [],
    likes: [],
    history: [],
    reports: [],
    subscriptions: [],
    signals: [],
    comments: [],
    live_chat_messages: [],
    stocks: [],
  };
}

function loadDataStore() {
  if (fs.existsSync(DATA_FILE)) {
    return normalizeDataStore(JSON.parse(fs.readFileSync(DATA_FILE, "utf8")));
  }
  if (fs.existsSync(SQLITE_EXPORT_FILE)) {
    console.warn(`[storage] Importing JSON datastore from ${SQLITE_EXPORT_FILE}`);
    const imported = normalizeDataStore(JSON.parse(fs.readFileSync(SQLITE_EXPORT_FILE, "utf8")));
    db = imported;
    saveDb();
    return imported;
  }
  const empty = normalizeDataStore(createEmptyDataStore());
  db = empty;
  saveDb();
  return empty;
}

function normalizeDataStore(raw) {
  const next = createEmptyDataStore();
  for (const key of Object.keys(next)) {
    next[key] = Array.isArray(raw && raw[key]) ? raw[key] : [];
  }
  next.users = next.users.map((user) => ({
    id: user.id,
    email: user.email,
    full_name: user.full_name || "",
    channel_name: user.channel_name || slugFromText((user.email || "").split("@")[0]),
    role: user.role || "user",
    password_hash: user.password_hash || "",
    password_salt: user.password_salt || "",
    created_at: user.created_at || new Date().toISOString(),
  }));
  next.sessions = next.sessions.map((session) => ({
    id: session.id,
    user_id: session.user_id,
    token_hash: session.token_hash || "",
    expires_at: session.expires_at || new Date().toISOString(),
    created_at: session.created_at || new Date().toISOString(),
  }));
  next.videos = next.videos.map((video) => ({
    id: video.id,
    title: video.title || "",
    description: video.description || "",
    thumbnail_url: video.thumbnail_url || "",
    video_url: video.video_url || "",
    current_frame_url: video.current_frame_url || "",
    channel_name: video.channel_name || "",
    owner_id: video.owner_id || "",
    category: video.category || "general",
    tags_json: typeof video.tags_json === "string" ? video.tags_json : JSON.stringify(video.tags || []),
    views: Number(video.views || 0),
    duration: video.duration || "0:00",
    is_live: Boolean(video.is_live),
    is_music: Boolean(video.is_music),
    created_at: video.created_at || new Date().toISOString(),
  }));
  next.likes = next.likes.map((like) => ({
    user_id: like.user_id,
    video_id: like.video_id,
    created_at: like.created_at || new Date().toISOString(),
  }));
  next.history = next.history.map((entry) => ({
    user_id: entry.user_id,
    video_id: entry.video_id,
    viewed_at: entry.viewed_at || new Date().toISOString(),
  }));
  next.reports = next.reports.map((report) => ({
    id: report.id || createId("report"),
    video_id: report.video_id,
    user_id: report.user_id,
    email: report.email || "",
    reason: report.reason || "",
    created_at: report.created_at || new Date().toISOString(),
  }));
  next.subscriptions = next.subscriptions.map((subscription) => ({
    user_id: subscription.user_id,
    channel_name: subscription.channel_name,
    created_at: subscription.created_at || new Date().toISOString(),
  }));
  next.signals = next.signals.map((signal) => ({
    id: signal.id || createId("signal"),
    video_id: signal.video_id,
    payload: typeof signal.payload === "string" ? signal.payload : JSON.stringify(signal.payload || {}),
    created_at: signal.created_at || new Date().toISOString(),
    source: signal.source || "broadcaster",
  }));
  next.comments = next.comments.map((comment) => ({
    id: comment.id || createId("comment"),
    video_id: comment.video_id,
    user_id: comment.user_id,
    content: comment.content || "",
    created_at: comment.created_at || new Date().toISOString(),
  }));
  next.live_chat_messages = next.live_chat_messages.map((message) => ({
    id: message.id || createId("lchat"),
    video_id: message.video_id,
    user_id: message.user_id,
    message: message.message || "",
    created_at: message.created_at || new Date().toISOString(),
  }));
  next.stocks = next.stocks.map((stock) => ({
    symbol: stock.symbol,
    display_name: stock.display_name || stock.symbol,
    price: Number(stock.price || 0),
    change: Number(stock.change || 0),
    change_percent: Number(stock.change_percent || 0),
    updated_at: stock.updated_at || new Date().toISOString(),
    trend_mode: stock.trend_mode || "stable",
  }));
  return next;
}

function persistDataStore() {
  saveDb();
}

function findUserByEmail(email) {
  const lowered = String(email || "").trim().toLowerCase();
  return db.users.find((user) => String(user.email || "").trim().toLowerCase() === lowered) || null;
}

function findUserById(userId) {
  return db.users.find((user) => user.id === userId) || null;
}

function findVideoById(videoId) {
  return db.videos.find((video) => video.id === videoId) || null;
}

function findSessionByToken(token) {
  const tokenHash = hashSessionToken(token);
  return db.sessions.find((session) => session.token_hash === tokenHash) || null;
}

function publicUserFields(user) {
  if (!user) return null;
  const liked = db.likes.filter((row) => row.user_id === user.id).map((row) => row.video_id);
  const history = db.history
    .filter((row) => row.user_id === user.id)
    .sort((a, b) => String(b.viewed_at).localeCompare(String(a.viewed_at)))
    .map((row) => row.video_id);
  const subscriptions = db.subscriptions
    .filter((row) => row.user_id === user.id)
    .map((row) => row.channel_name);
  return {
    id: user.id,
    email: user.email,
    full_name: user.full_name,
    channel_name: user.channel_name,
    role: user.role,
    created_at: user.created_at,
    liked_video_ids: liked,
    history_video_ids: history,
    subscribed_channels: subscriptions,
  };
}

function listVideosWithMetrics() {
  const likesMap = new Map();
  for (const like of db.likes) {
    likesMap.set(like.video_id, (likesMap.get(like.video_id) || 0) + 1);
  }
  const reportsMap = new Map();
  for (const report of db.reports) {
    const list = reportsMap.get(report.video_id) || [];
    list.push(report);
    reportsMap.set(report.video_id, list);
  }
  return [...db.videos]
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .map((video) => ({
      ...video,
      likes: likesMap.get(video.id) || 0,
      report_count: reportsMap.get(video.id)?.length || 0,
      reports: reportsMap.get(video.id) || [],
      tags: parseTagsJson(video.tags_json),
    }));
}

function listCommentsForVideo(videoId) {
  return db.comments
    .filter((comment) => comment.video_id === videoId)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 200)
    .map((comment) => {
      const user = findUserById(comment.user_id) || {};
      return {
        id: comment.id,
        content: comment.content,
        created_at: comment.created_at,
        user_id: user.id || comment.user_id,
        channel_name: user.channel_name || "",
        full_name: user.full_name || "",
      };
    });
}

function insertComment(videoId, userId, content) {
  const record = {
    id: createId("comment"),
    video_id: videoId,
    user_id: userId,
    content,
    created_at: new Date().toISOString(),
  };
  db.comments.push(record);
  persistDataStore();
  return listCommentsForVideo(videoId).find((comment) => comment.id === record.id) || null;
}

function deleteComment(videoId, commentId) {
  db.comments = db.comments.filter((comment) => !(comment.id === commentId && comment.video_id === videoId));
  persistDataStore();
}

function listLiveChatMessages(videoId, limit = 80) {
  return db.live_chat_messages
    .filter((message) => message.video_id === videoId)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .slice(-limit)
    .map((message) => {
      const user = findUserById(message.user_id) || {};
      return {
        id: message.id,
        video_id: message.video_id,
        message: message.message,
        created_at: message.created_at,
        user_id: user.id || message.user_id,
        channel_name: user.channel_name || "",
        full_name: user.full_name || "",
      };
    });
}

function insertLiveChatMessage(videoId, userId, message) {
  const record = {
    id: createId("lchat"),
    video_id: videoId,
    user_id: userId,
    message,
    created_at: new Date().toISOString(),
  };
  db.live_chat_messages.push(record);
  persistDataStore();
  return listLiveChatMessages(videoId).find((entry) => entry.id === record.id) || null;
}

function ensureDefaultStocks() {
  const now = new Date().toISOString();
  const entry = db.stocks.find((stock) => stock.symbol === "mytube.co");
  if (!entry) {
    db.stocks.push({
      symbol: "mytube.co",
      display_name: "mytube.co",
      price: 100,
      change: 0,
      change_percent: 0,
      updated_at: now,
      trend_mode: "stable",
    });
    persistDataStore();
  }
}

function ensureAdminUsers() {
  const admins = [
    {
      email: "sjordan4076@mytube.co",
      password: "71678",
      fullName: "Sebastian Jordan",
      channel: "sjordan4076",
    },
    {
      email: "jjordan4084@mytube.co",
      password: "71650",
      fullName: "Jordan Admin",
      channel: "jjordan4084",
    },
    {
      email: "Suckysuckyhair_dev@mytube.co",
      password: "Dingleberry",
      fullName: "Suckysuckyhair Dev",
      channel: "suckysuckyhair-dev",
    },
  ];

  for (const admin of admins) {
    const existing = findUserByEmail(admin.email);
    if (existing) continue;
    const userId = createId("user");
    const pass = createPasswordHash(admin.password);
    db.users.push({
      id: userId,
      email: admin.email,
      full_name: admin.fullName,
      channel_name: slugFromText(admin.channel),
      role: "admin",
      password_hash: pass.hash,
      password_salt: pass.salt,
      created_at: new Date().toISOString(),
    });
  }
  persistDataStore();
  persistLegacyUsers();
}

function migrateLegacyJsonData() {
  if (fs.existsSync(LEGACY_USERS_FILE)) {
    const users = JSON.parse(fs.readFileSync(LEGACY_USERS_FILE, "utf8"));
    for (const u of users) {
      if (!u || !u.email || !u.id || !u.password_hash || !u.password_salt) {
        continue;
      }

      const existingByEmail = findUserByEmail(u.email);
      const existingById = findUserById(u.id);

      if (existingByEmail || existingById) {
        const target = existingById || existingByEmail;
        Object.assign(target, {
          id: u.id,
          email: u.email,
          full_name: u.full_name || "",
          channel_name: u.channel_name || slugFromText(u.email.split("@")[0]),
          role: u.role || "user",
          password_hash: u.password_hash,
          password_salt: u.password_salt,
          created_at: u.created_at || new Date().toISOString(),
        });
        continue;
      }

      db.users.push({
        id: u.id,
        email: u.email,
        full_name: u.full_name || "",
        channel_name: u.channel_name || slugFromText(u.email.split("@")[0]),
        role: u.role || "user",
        password_hash: u.password_hash,
        password_salt: u.password_salt,
        created_at: u.created_at || new Date().toISOString(),
      });
    }
  }

  if (fs.existsSync(LEGACY_VIDEOS_FILE)) {
    const videos = JSON.parse(fs.readFileSync(LEGACY_VIDEOS_FILE, "utf8"));
    for (const v of videos) {
      if (!findVideoById(v.id)) {
        db.videos.push({
          id: v.id,
          title: v.title,
          description: v.description,
          thumbnail_url: v.thumbnail_url,
          video_url: v.video_url,
          current_frame_url: v.current_frame_url || "",
          channel_name: v.channel_name,
          owner_id: v.owner_id,
          category: v.category || "general",
          tags_json: JSON.stringify(v.tags || []),
          views: Number(v.views || 0),
          duration: v.duration || "0:00",
          is_live: Boolean(v.is_live),
          is_music: Boolean(v.is_music),
          created_at: v.created_at || new Date().toISOString(),
        });
      }
    }
  }
  persistDataStore();
}

function persistLegacyUsers() {
  const users = [...db.users]
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .map((user) => ({
      id: user.id,
      email: user.email,
      full_name: user.full_name,
      channel_name: user.channel_name,
      role: user.role,
      password_hash: user.password_hash,
      password_salt: user.password_salt,
      created_at: user.created_at,
    }));
  fs.writeFileSync(LEGACY_USERS_FILE, JSON.stringify(users, null, 2));
}

function persistLegacyVideos() {
  const videos = [...db.videos].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).map((video) => ({
    id: video.id,
    title: video.title,
    description: video.description,
    thumbnail_url: video.thumbnail_url,
    video_url: video.video_url,
    current_frame_url: video.current_frame_url,
    channel_name: video.channel_name,
    owner_id: video.owner_id,
    category: video.category,
    tags: parseTagsJson(video.tags_json),
    views: Number(video.views || 0),
    duration: video.duration,
    is_live: Boolean(video.is_live),
    is_music: Boolean(video.is_music),
    created_at: video.created_at,
  }));
  fs.writeFileSync(LEGACY_VIDEOS_FILE, JSON.stringify(videos, null, 2));
}

function clearExpiredSessions() {
  const now = Date.now();
  db.sessions = db.sessions.filter((session) => sessionExpiresAt(session.expires_at) >= now);
  persistDataStore();
}

function listVideos() {
  return listVideosWithMetrics();
}

function formatChatPayload(row) {
  if (!row) return null;
  return {
    id: row.id,
    videoId: row.video_id,
    message: row.message,
    created_at: row.created_at,
    user_id: row.user_id,
    channel_name: row.channel_name,
    full_name: row.full_name,
  };
}

function getLiveViewerCounts() {
  return Object.fromEntries(Array.from(viewerCounts.entries()));
}

function adjustViewerCount(videoId, delta) {
  const current = viewerCounts.get(videoId) || 0;
  const next = Math.max(0, current + delta);
  if (next === 0) {
    viewerCounts.delete(videoId);
  } else {
    viewerCounts.set(videoId, next);
  }
  broadcastViewerCount(videoId);
}

function broadcastViewerCount(videoId) {
  const count = viewerCounts.get(videoId) || 0;
  broadcastToLiveChat(videoId, "viewer-count", { videoId, count });
}

function broadcastToLiveChat(videoId, event, payload) {
  const clients = liveChatStreams.get(videoId);
  if (!clients || !clients.size) return;
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    try {
      client.write(data);
    } catch {
      // ignore write errors
    }
  }
}

function registerLiveChatClient(videoId, res) {
  ensureViewerCountInitialized(videoId);
  const next = liveChatStreams.get(videoId) || new Set();
  next.add(res);
  liveChatStreams.set(videoId, next);
  adjustViewerCount(videoId, 1);
  if (viewerCounts.has(videoId)) {
    broadcastViewerCount(videoId);
  }
  return () => {
    next.delete(res);
    adjustViewerCount(videoId, -1);
  };
}

function ensureViewerCountInitialized(videoId) {
  if (!viewerCounts.has(videoId)) {
    viewerCounts.set(videoId, 0);
  }
}

function updateMyTubeStock(values) {
  const now = new Date().toISOString();
  const stock = db.stocks.find((entry) => entry.symbol === "mytube.co");
  if (!stock) {
    db.stocks.push({
      symbol: "mytube.co",
      display_name: "mytube.co",
      price: values.price,
      change: values.change,
      change_percent: values.changePercent,
      updated_at: now,
      trend_mode: normalizeTrendMode(values.trendMode),
    });
  } else {
    stock.price = values.price;
    stock.change = values.change;
    stock.change_percent = values.changePercent;
    stock.updated_at = now;
    stock.trend_mode = normalizeTrendMode(values.trendMode || stock.trend_mode);
  }
  persistDataStore();
}

function getVideoRow(id) {
  return findVideoById(id);
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

async function fetchRealStockQuotes() {
  const symbols = STOCK_SYMBOLS.join(",");
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols}`;
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          const result = json.quoteResponse?.result || [];
          const normalized = result.map((item) => ({
            symbol: item.symbol,
            shortName: item.shortName || item.longName || item.symbol,
            price: Number(item.regularMarketPrice || item.lastPrice || 0),
            change: Number(item.regularMarketChange || item.regularMarketChangePercent || 0),
            changePercent: Number(item.regularMarketChangePercent || 0),
            marketState: item.marketState || "REGULAR",
          }));
          resolve(normalized);
        } catch (e) {
          reject(e);
        }
      });
    }).on("error", reject);
  });
}

async function fetchStocks() {
  advanceMyTubeStock();
  let realStocks = [];
  try {
    realStocks = await fetchRealStockQuotes();
  } catch {
    realStocks = STOCK_FALLBACKS;
  }
  if (!realStocks.length) {
    realStocks = STOCK_FALLBACKS;
  }
  const customStocks = db.stocks;
  const normalizedCustom = customStocks.map((row) => ({
    symbol: row.symbol,
    shortName: row.display_name || row.symbol,
    price: Number(row.price || 0),
    change: Number(row.change || 0),
    changePercent: Number(row.change_percent || 0),
    marketState: row.symbol === "mytube.co" ? `MYTUBE ${formatTrendLabel(row.trend_mode)}` : "LOCAL",
    updated_at: row.updated_at,
    trendMode: row.trend_mode || "stable",
  }));
  return [...normalizedCustom, ...realStocks];
}

function normalizeTrendMode(value) {
  const next = String(value || "stable").trim().toLowerCase().replace(/\s+/g, "_");
  if (["fast_growth", "slow_growth", "plummet", "slow_decline", "stable"].includes(next)) {
    return next;
  }
  return "stable";
}

function formatTrendLabel(mode) {
  switch (normalizeTrendMode(mode)) {
    case "fast_growth":
      return "FAST GROWTH";
    case "slow_growth":
      return "SLOW GROWTH";
    case "plummet":
      return "PLUMMET";
    case "slow_decline":
      return "SLOW DECLINE";
    default:
      return "STABLE";
  }
}

function advanceMyTubeStock() {
  const stock = db.stocks.find((entry) => entry.symbol === "mytube.co");
  if (!stock) return;
  const now = Date.now();
  const previous = new Date(stock.updated_at || 0).getTime();
  if (!Number.isFinite(previous)) return;
  const elapsedMs = now - previous;
  if (elapsedMs < 5000) return;

  const elapsedSteps = Math.min(20, Math.max(1, Math.floor(elapsedMs / 15000)));
  const previousPrice = Math.max(0.01, Number(stock.price || 100));
  let nextPrice = previousPrice;

  for (let index = 0; index < elapsedSteps; index++) {
    nextPrice *= 1 + getTrendDelta(normalizeTrendMode(stock.trend_mode));
  }

  nextPrice = Math.max(0.01, Number(nextPrice.toFixed(2)));
  stock.change = Number((nextPrice - previousPrice).toFixed(2));
  stock.change_percent = Number((((nextPrice - previousPrice) / previousPrice) * 100).toFixed(2));
  stock.price = nextPrice;
  stock.updated_at = new Date(now).toISOString();
  persistDataStore();
}

function getTrendDelta(mode) {
  switch (mode) {
    case "fast_growth":
      return 0.02 + Math.random() * 0.025;
    case "slow_growth":
      return 0.0015 + Math.random() * 0.004;
    case "plummet":
      return -(0.03 + Math.random() * 0.045);
    case "slow_decline":
      return -(0.001 + Math.random() * 0.004);
    default:
      return (Math.random() - 0.5) * 0.002;
  }
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
    res.writeHead(403, buildCorsHeaders(req));
    res.end("Forbidden");
    return;
  }

  fs.stat(resolved, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, buildCorsHeaders(req));
      res.end("Not found");
      return;
    }

    const ext = path.extname(resolved).toLowerCase();
    const headers = {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      ...buildCorsHeaders(req),
    };
    res.writeHead(200, headers);
    const stream = fs.createReadStream(resolved);
    stream.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(500, buildCorsHeaders(req));
      }
      res.end("Server error");
    });
    stream.pipe(res);
  });
}
