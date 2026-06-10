const root = document.getElementById("root");

const state = {
  user: null,
  videos: [],
  stocks: [],
  stockHistoryBySymbol: {},
  stocksUpdatedAt: "",
  stockChartRange: "day",
  selectedStockSymbol: "mytube.co",
  route: null,
  sidebarCollapsed: window.innerWidth < 768,
  loading: true,
  authLoading: false,
  uploadLoading: false,
  error: "",
  notice: "",
  searchInput: "",
  lastViewedRoute: "",
  liveBroadcastId: "",
  liveCameraEnabled: false,
  liveChatMessagesByVideo: {},
  liveFrameByVideo: {},
  chatDraft: "",
  commentsByVideo: {},
  commentDraft: "",
  liveViewerCounts: {},
};

const runtime = {
  cameraStream: null,
  captureVideo: null,
  broadcastPeers: {},
  liveSignalTimer: null,
  liveFrameTimer: null,
  liveFrameUploadInFlight: false,
  pagePollTimer: null,
  stockPollTimer: null,
  viewerPC: null,
  viewerPoll: null,
  viewerVideoId: "",
  viewerPeerId: "",
  viewerAudioContext: null,
  viewerAudioSource: null,
  viewerAudioGain: null,
  liveChatSource: null,
  liveChatVideoId: "",
  liveViewerPoller: null,
};

const THEME_STORAGE_KEY = "theme";
const THEME_VARS_STYLE_ID = "theme-vars";

const routeTable = [
  { name: "home", pattern: "/" },
  { name: "trending", pattern: "/trending" },
  { name: "subscriptions", pattern: "/subscriptions" },
  { name: "search", pattern: "/search" },
  { name: "watch", pattern: "/watch/:id" },
  { name: "upload", pattern: "/upload" },
  { name: "go-live", pattern: "/go-live" },
  { name: "profile", pattern: "/profile" },
  { name: "channel", pattern: "/channel" },
  { name: "channel-detail", pattern: "/channel/:channel" },
  { name: "music", pattern: "/music" },
  { name: "live", pattern: "/live" },
  { name: "stock", pattern: "/stock" },
  { name: "sports", pattern: "/sports" },
  { name: "admin", pattern: "/admin" },
  { name: "liked", pattern: "/liked" },
  { name: "history", pattern: "/history" },
  { name: "login", pattern: "/login" },
  { name: "signup", pattern: "/signup" },
];

const sidebarSections = [
  {
    title: "",
    items: [
      { label: "Home", route: "/" },
      { label: "Trending", route: "/trending" },
      { label: "Subscriptions", route: "/subscriptions" },
    ],
  },
  {
    title: "Library",
    items: [
      { label: "History", route: "/history" },
      { label: "Liked Videos", route: "/liked" },
      { label: "Profile", route: "/profile" },
      { label: "My Channel", route: "/channel" },
    ],
  },
  {
    title: "Create",
    items: [
      { label: "Upload", route: "/upload" },
      { label: "Go Live", route: "/go-live" },
    ],
  },
  {
    title: "Explore",
    items: [
      { label: "MyTube Music", route: "/music" },
      { label: "MyTube Live", route: "/live" },
      { label: "MyTube Stock", route: "/stock" },
      { label: "MyTube Sports", route: "/sports" },
    ],
  },
];

state.route = parseRoute();
initializeTheme();

window.addEventListener("hashchange", async () => {
  state.route = parseRoute();
  await handleRouteEffects();
  render();
});

window.addEventListener("resize", () => {
  if (window.innerWidth < 768) {
    state.sidebarCollapsed = true;
  }
  render();
});

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action], [data-route]");
  if (!button) return;

  if (button.dataset.route) {
    event.preventDefault();
    setRoute(button.dataset.route);
    return;
  }

  const action = button.dataset.action;

  if (action === "toggle-sidebar") {
    state.sidebarCollapsed = !state.sidebarCollapsed;
    render();
    return;
  }

  if (action === "toggle-theme") {
    toggleTheme();
    render();
    return;
  }

  if (action === "scroll-section") {
    const target = document.getElementById(button.dataset.section || "");
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }

  if (action === "logout") {
    try {
      await api("/api/logout", { method: "POST" });
    } catch {}
    state.user = null;
    state.videos = [];
    state.notice = "You have been logged out.";
    state.route = parseRoute();
    setRoute("/");
    return;
  }

  if (action === "like-video") {
    await toggleLike(button.dataset.videoId);
    return;
  }

  if (action === "report-video") {
    const reason = window.prompt("What makes this video inappropriate?", "Inappropriate content");
    if (reason === null) return;
    await reportVideo(button.dataset.videoId, reason);
    return;
  }

  if (action === "delete-video") {
    const confirmed = window.confirm("Delete this video?");
    if (!confirmed) return;
    await deleteVideo(button.dataset.videoId);
    return;
  }

  if (action === "subscribe-channel") {
    await toggleSubscribe(button.dataset.channelName);
    return;
  }

  if (action === "refresh-data") {
    await refreshAppData();
    return;
  }

  if (action === "select-stock") {
    state.selectedStockSymbol = button.dataset.symbol || "";
    render();
    return;
  }

  if (action === "set-stock-range") {
    state.stockChartRange = button.dataset.range || "day";
    render();
    return;
  }

  if (action === "delete-comment") {
    await deleteComment(button.dataset.videoId, button.dataset.commentId);
    return;
  }

  if (action === "enable-camera") {
    await enableCamera();
    return;
  }

  if (action === "stop-live") {
    await stopLiveBroadcast();
    return;
  }
});

document.addEventListener("submit", async (event) => {
  const form = event.target;

  if (form.matches("[data-login-form]")) {
    event.preventDefault();
    await login(new FormData(form));
    return;
  }

  if (form.matches("[data-signup-form]")) {
    event.preventDefault();
    await signup(new FormData(form));
    return;
  }

  if (form.matches("[data-search-form]")) {
    event.preventDefault();
    const query = String(new FormData(form).get("query") || "").trim();
    state.searchInput = query;
    setRoute(`/search?q=${encodeURIComponent(query)}`);
    return;
  }

  if (form.matches("[data-upload-form]")) {
    event.preventDefault();
    await createVideo(new FormData(form));
  }

  if (form.matches("[data-live-chat-form]")) {
    event.preventDefault();
    const videoId = form.dataset.videoId;
    const message = String(new FormData(form).get("message") || "").trim();
    if (message) {
      await sendLiveChatMessage(videoId, message);
    }
    return;
  }

  if (form.matches("[data-comment-form]")) {
    event.preventDefault();
    const videoId = form.dataset.videoId;
    const content = String(new FormData(form).get("comment") || "").trim();
    if (content) {
      await postComment(videoId, content);
    }
    return;
  }

  if (form.matches("[data-mytube-stock-form]")) {
    event.preventDefault();
    await updateMyTubeStock(form);
    return;
  }
});

document.addEventListener("input", (event) => {
  const chatInput = event.target.closest("[data-live-chat-input]");
  if (chatInput) {
    state.chatDraft = chatInput.value;
  }
  const commentInput = event.target.closest("[data-comment-input]");
  if (commentInput) {
    state.commentDraft = commentInput.value;
  }
});

bootstrap();

async function bootstrap() {
  await refreshAppData();

  await handleRouteEffects();
  render();
}

function parseRoute() {
  const raw = window.location.hash.replace(/^#/, "") || "/";
  const [pathPart, queryString = ""] = raw.split("?");
  const path = normalizePath(pathPart || "/");
  const query = Object.fromEntries(new URLSearchParams(queryString));

  for (const route of routeTable) {
    const match = matchPattern(route.pattern, path);
    if (match) {
      return { ...route, path, raw, query, params: match.params };
    }
  }

  return { name: "not-found", pattern: "*", path, raw, query, params: {} };
}

function matchPattern(pattern, path) {
  const patternParts = normalizePath(pattern).split("/").filter(Boolean);
  const pathParts = normalizePath(path).split("/").filter(Boolean);

  if (patternParts.length !== pathParts.length) return null;

  const params = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const patternPart = patternParts[index];
    const pathPart = pathParts[index];

    if (patternPart.startsWith(":")) {
      params[patternPart.slice(1)] = decodeURIComponent(pathPart);
      continue;
    }

    if (patternPart !== pathPart) {
      return null;
    }
  }

  return { params };
}

function normalizePath(path) {
  if (!path) return "/";
  return `/${path.replace(/^\/+/, "").replace(/\/+$/, "")}`.replace(/^\/$/, "/");
}

function isPublicRoute(name) {
  return name === "login" || name === "signup";
}

function setRoute(route) {
  const normalized = route.startsWith("/") ? route : `/${route}`;
  window.location.hash = normalized;
}

async function api(path, options = {}) {
  const headers = {
    ...(options.body && !options.formData ? { "Content-Type": "application/json" } : {}),
    ...(options.headers || {}),
  };

  const response = await fetch(path, {
    method: options.method || "GET",
    headers,
    credentials: "same-origin",
    body: options.body ? (options.formData ? options.body : JSON.stringify(options.body)) : undefined,
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(data.error || "Request failed.");
  }

  return data;
}

async function refreshAppData() {
  state.loading = true;
  render();
  const hadUser = Boolean(state.user);

  try {
    const [user, videosResponse] = await Promise.all([api("/api/me"), api("/api/videos")]);
    state.user = user;
    state.videos = videosResponse.videos || [];
    state.error = "";
  } catch (error) {
    state.user = null;
    state.videos = [];
    if (hadUser) {
      state.error = error.message;
    }
  } finally {
    state.loading = false;
  }
}

async function handleRouteEffects() {
  if (!state.user) return;

  if (state.route.name === "watch" && state.route.raw !== state.lastViewedRoute) {
    state.lastViewedRoute = state.route.raw;
    try {
      await api(`/api/videos/${encodeURIComponent(state.route.params.id)}/view`, { method: "POST" });
      await refreshAppData();
    } catch (error) {
      state.notice = error.message;
    }
  }

  if (state.route.name === "watch") {
    const video = state.videos.find((entry) => entry.id === state.route.params.id);
    if (video) {
      if (video.is_live) {
        void loadLiveChatHistory(video.id);
      } else {
        await loadComments(video.id);
      }
    }
  }
}

async function login(formData) {
  state.authLoading = true;
  state.error = "";
  render();

  try {
    const payload = await api("/api/login", {
      method: "POST",
      body: {
        email: String(formData.get("email") || "").trim(),
        password: String(formData.get("password") || ""),
      },
    });

    await refreshAppData();
    state.notice = "Signed in successfully.";
    setRoute("/");
  } catch (error) {
    state.error = error.message;
  } finally {
    state.authLoading = false;
    render();
  }
}

async function signup(formData) {
  state.authLoading = true;
  state.error = "";
  render();

  try {
    const payload = await api("/api/signup", {
      method: "POST",
      body: {
        full_name: String(formData.get("full_name") || "").trim(),
        email: String(formData.get("email") || "").trim(),
        password: String(formData.get("password") || ""),
        channel_name: String(formData.get("channel_name") || "").trim(),
      },
    });

    await refreshAppData();
    state.notice = "Account created.";
    setRoute("/");
  } catch (error) {
    state.error = error.message;
  } finally {
    state.authLoading = false;
    render();
  }
}

async function createVideo(formData) {
  state.uploadLoading = true;
  state.error = "";
  render();

  try {
    const isLive = String(formData.get("is_live") || "").toLowerCase() === "true" || formData.get("is_live") === "on";
    const isMusic = formData.get("is_music") === "on";
    const isFinancial = formData.get("is_financial") === "on";
    const isSports = formData.get("is_sports") === "on";
    const rawTags = String(formData.get("tags") || "");
    const normalizedTags = Array.from(new Set([
      ...rawTags.split(",").map((tag) => tag.trim()).filter(Boolean),
      ...(isFinancial ? ["stock", "finance"] : []),
      ...(isSports ? ["sports", "athletics"] : []),
    ])).join(", ");
    if (isLive && !runtime.cameraStream) {
      throw new Error("Enable your camera before starting a live broadcast.");
    }

    const multipart = new FormData();
    multipart.set("title", String(formData.get("title") || "").trim());
    multipart.set("description", String(formData.get("description") || "").trim());
    multipart.set("channel_name", state.user?.channel_name || "");
    multipart.set("category", isFinancial ? "stock" : isSports ? "sports" : String(formData.get("category") || "general"));
    multipart.set("tags", normalizedTags);
    multipart.set("duration", String(formData.get("duration") || "0:00"));
    multipart.set("is_live", isLive ? "true" : "false");
    multipart.set("is_music", isMusic ? "true" : "false");
    multipart.set("is_sports", isSports ? "true" : "false");
    const thumbnailFile = formData.get("thumbnail_file");
    const videoFile = formData.get("video_file");
    if (thumbnailFile && thumbnailFile.size) {
      multipart.set("thumbnail_file", thumbnailFile);
    }
    if (!isLive && videoFile && videoFile.size) {
      multipart.set("file", videoFile);
    }

    const payload = isLive
      ? await api("/api/videos", {
          method: "POST",
          body: multipart,
          formData: true,
        })
      : await api("/upload", {
          method: "POST",
          body: multipart,
          formData: true,
        });

    if (isLive) {
      try {
        await startLiveBroadcast(payload.video.id);
        state.liveBroadcastId = payload.video.id;
      } catch (error) {
        cleanupLiveConnection();
        throw error;
      }
    }

    if (!isLive) {
      const uploadedVideo = payload.video || payload.row || payload.data || null;
      if (!uploadedVideo) {
        throw new Error("Upload succeeded, but no video record was returned.");
      }
      state.videos = [uploadedVideo, ...state.videos.filter((video) => video.id !== uploadedVideo.id)];
      state.notice = "Video uploaded.";
      setRoute(`/watch/${uploadedVideo.id}`);
      return;
    }

    await refreshAppData();
    state.notice = "Live stream created.";
    setRoute(`/watch/${payload.video.id}`);
    } catch (error) {
      state.error = error.message;
    } finally {
      state.uploadLoading = false;
      render();
    }
}

async function sendLiveChatMessage(videoId, message) {
  try {
    await api(`/api/videos/${encodeURIComponent(videoId)}/chat`, {
      method: "POST",
      body: { message },
    });
    state.chatDraft = "";
    render();
  } catch (error) {
    state.notice = error.message;
    render();
  }
}

async function postComment(videoId, content) {
  state.commentDraft = "";
  render();
  try {
    await api(`/api/videos/${encodeURIComponent(videoId)}/comments`, {
      method: "POST",
      body: { content },
    });
    await loadComments(videoId);
  } catch (error) {
    state.notice = error.message;
    render();
  }
}

async function deleteComment(videoId, commentId) {
  try {
    await api(`/api/videos/${encodeURIComponent(videoId)}/comments/${encodeURIComponent(commentId)}`, {
      method: "DELETE",
    });
    await loadComments(videoId);
  } catch (error) {
    state.notice = error.message;
    render();
  }
}

async function loadComments(videoId) {
  try {
    const payload = await api(`/api/videos/${encodeURIComponent(videoId)}/comments`);
    state.commentsByVideo[videoId] = payload.comments || [];
    render();
  } catch (error) {
    state.commentsByVideo[videoId] = [];
    render();
  }
}

async function loadLiveChatHistory(videoId) {
  try {
    const payload = await api(`/api/videos/${encodeURIComponent(videoId)}/chat`);
    state.liveChatMessagesByVideo[videoId] = payload.messages || [];
    render();
  } catch {
    state.liveChatMessagesByVideo[videoId] = [];
  }
}

async function updateMyTubeStock(form) {
  const formData = new FormData(form);
  const price = Number(formData.get("price"));
  const change = Number(formData.get("change"));
  const changePercent = Number(formData.get("change_percent") ?? formData.get("changePercent") ?? 0);
  const trendMode = String(formData.get("trend_mode") || "stable");
  if (Number.isNaN(price) || Number.isNaN(change) || Number.isNaN(changePercent)) {
    state.notice = "Invalid stock values.";
    render();
    return;
  }

  try {
    await api("/api/stocks/mytube", {
      method: "POST",
      body: { price, change, changePercent, trendMode },
    });
    await refreshStocks();
    state.notice = "MyTube stock updated.";
    render();
  } catch (error) {
    state.notice = error.message;
    render();
  }
}

async function startLiveBroadcast(videoId) {
  if (!runtime.cameraStream) {
    throw new Error("Camera stream is not available.");
  }

  cleanupLiveConnection();
  await pushLiveFrame(videoId).catch(() => {});
  runtime.liveFrameTimer = window.setInterval(() => {
    pushLiveFrame(videoId).catch((error) => {
      console.error("Live frame push error:", error);
    });
  }, 90);

  runtime.liveSignalTimer = setInterval(async () => {
    try {
      const { signals = [] } = await api(`/api/videos/${videoId}/signal?for=broadcaster`);
      for (const signal of signals) {
        const peerId = String(signal.peer_id || "").trim();
        if (!peerId) {
          continue;
        }
        if (signal.type === "viewer-ready") {
          await ensureBroadcastPeer(videoId, peerId);
          continue;
        }
        if (signal.type === "viewer-left") {
          removeBroadcastPeer(peerId);
          continue;
        }
        const peer = runtime.broadcastPeers[peerId];
        if (!peer) {
          continue;
        }
        if (signal.type === "answer" && signal.answer && !peer.currentRemoteDescription) {
          await peer.setRemoteDescription(new RTCSessionDescription(signal.answer));
        }
        if (signal.type === "candidate" && signal.candidate) {
          await peer.addIceCandidate(new RTCIceCandidate(signal.candidate));
        }
      }
    } catch (error) {
      console.error("Broadcast signal poll error:", error);
    }
  }, 1000);
}

async function ensureBroadcastPeer(videoId, peerId) {
  if (runtime.broadcastPeers[peerId]) {
    return runtime.broadcastPeers[peerId];
  }

  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });
  runtime.broadcastPeers[peerId] = pc;

  runtime.cameraStream.getAudioTracks().forEach((track) => {
    pc.addTrack(track, runtime.cameraStream);
  });

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      api(`/api/videos/${videoId}/signal`, {
        method: "POST",
        body: { type: "candidate", candidate: event.candidate, source: "broadcaster", peer_id: peerId },
      }).catch(() => {});
    }
  };

  pc.onconnectionstatechange = () => {
    if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
      removeBroadcastPeer(peerId);
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await api(`/api/videos/${videoId}/signal`, {
    method: "POST",
    body: { type: "offer", offer, source: "broadcaster", peer_id: peerId },
  });

  return pc;
}

function removeBroadcastPeer(peerId) {
  const peer = runtime.broadcastPeers[peerId];
  if (!peer) return;
  peer.close();
  delete runtime.broadcastPeers[peerId];
}

async function toggleLike(videoId) {
  try {
    await api(`/api/videos/${encodeURIComponent(videoId)}/toggle-like`, { method: "POST" });
    await refreshAppData();
  } catch (error) {
    state.notice = error.message;
    render();
  }
}

async function reportVideo(videoId, reason) {
  try {
    await api(`/api/videos/${encodeURIComponent(videoId)}/report`, {
      method: "POST",
      body: { reason },
    });
    await refreshAppData();
    state.notice = "Video reported for admin review.";
    render();
  } catch (error) {
    state.notice = error.message;
    render();
  }
}

async function deleteVideo(videoId) {
  try {
    await api(`/api/videos/${encodeURIComponent(videoId)}`, { method: "DELETE" });
    if (state.liveBroadcastId === videoId) {
      cleanupLiveConnection();
      state.liveBroadcastId = "";
      state.liveCameraEnabled = false;
    }
    delete state.liveChatMessagesByVideo[videoId];
    delete state.commentsByVideo[videoId];
    delete state.liveViewerCounts[videoId];
    delete state.liveFrameByVideo[videoId];
    await refreshAppData();
    state.notice = "Video deleted.";
    if (state.route.name === "watch" && state.route.params.id === videoId) {
      setRoute("/");
      return;
    }
    render();
  } catch (error) {
    state.notice = error.message;
    render();
  }
}

async function toggleSubscribe(channelName) {
  try {
    await api(`/api/channels/${encodeURIComponent(channelName)}/subscribe`, { method: "POST" });
    await refreshAppData();
  } catch (error) {
    state.notice = error.message;
    render();
  }
}

function fillAuthForm(email, password) {
  const emailInput = document.querySelector('input[name="email"]');
  const passwordInput = document.querySelector('input[name="password"]');
  if (emailInput) emailInput.value = email;
  if (passwordInput) passwordInput.value = password;
}

async function enableCamera() {
  try {
    if (runtime.cameraStream) {
      state.liveCameraEnabled = true;
      state.notice = "Camera already enabled.";
      render();
      return;
    }

    runtime.cameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 960, max: 1280 },
        height: { ideal: 540, max: 720 },
        frameRate: { ideal: 24, max: 30 },
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    runtime.captureVideo = document.createElement("video");
    runtime.captureVideo.autoplay = true;
    runtime.captureVideo.muted = true;
    runtime.captureVideo.playsInline = true;
    runtime.captureVideo.srcObject = runtime.cameraStream;
    await runtime.captureVideo.play().catch(() => {});
    state.liveCameraEnabled = true;
    state.notice = "Camera enabled. You can start broadcasting now.";
    render();
  } catch (error) {
    state.notice = "Camera access was denied.";
    render();
  }
}

function syncLivePreview() {
  const preview = document.getElementById("live-camera-preview");
  if (!preview) return;
  preview.srcObject = runtime.cameraStream || null;
  if (runtime.cameraStream) {
    preview.play().catch(() => {});
  }
}

function syncBackgroundEffects() {
  if (state.route.name === "stock" && state.user) {
    if (!runtime.stockPollTimer) {
      refreshStocks();
      runtime.stockPollTimer = window.setInterval(refreshStocks, 15000);
    }
  } else if (runtime.stockPollTimer) {
    clearInterval(runtime.stockPollTimer);
    runtime.stockPollTimer = null;
  }

  const watchingLiveVideo =
    state.route.name === "watch" &&
    state.user &&
    state.videos.some((video) => video.id === state.route.params.id && video.is_live);

  if (state.route.name === "live") {
    if (!runtime.pagePollTimer) {
      runtime.pagePollTimer = window.setInterval(refreshAppData, 5000);
    }
  } else if (runtime.pagePollTimer) {
    clearInterval(runtime.pagePollTimer);
    runtime.pagePollTimer = null;
  }

  const hasLiveVideo = state.videos.some((video) => video.is_live);
  if (!state.user) {
    if (runtime.liveViewerPoller) {
      clearInterval(runtime.liveViewerPoller);
      runtime.liveViewerPoller = null;
    }
  } else if (hasLiveVideo && !runtime.liveViewerPoller) {
    updateLiveViewerCounts();
    runtime.liveViewerPoller = window.setInterval(updateLiveViewerCounts, 5000);
  } else if (!hasLiveVideo && runtime.liveViewerPoller) {
    clearInterval(runtime.liveViewerPoller);
    runtime.liveViewerPoller = null;
  }
}

function cleanupLiveConnection() {
  if (runtime.liveSignalTimer) {
    clearInterval(runtime.liveSignalTimer);
    runtime.liveSignalTimer = null;
  }
  if (runtime.liveFrameTimer) {
    clearInterval(runtime.liveFrameTimer);
    runtime.liveFrameTimer = null;
  }
  runtime.liveFrameUploadInFlight = false;
  for (const peerId of Object.keys(runtime.broadcastPeers)) {
    removeBroadcastPeer(peerId);
  }
}

async function refreshStocks() {
  try {
    const payload = await api("/api/stocks");
    state.stocks = payload.stocks || [];
    state.stocksUpdatedAt = payload.updated_at || "";
    state.stockHistoryBySymbol = buildStockHistoryMap(state.stocks);
    if (!state.selectedStockSymbol || !state.stocks.some((stock) => stock.symbol === state.selectedStockSymbol)) {
      state.selectedStockSymbol = state.stocks[0]?.symbol || "mytube.co";
    }
    if (state.route.name === "stock") {
      render();
    }
  } catch (error) {
    if (state.route.name === "stock") {
      state.notice = error.message;
      render();
    }
  }
}

async function updateLiveViewerCounts() {
  try {
    const payload = await api("/api/videos/live-viewers");
    state.liveViewerCounts = payload.counts || {};
    render();
  } catch (error) {
    console.error("Viewer count poll failed:", error);
  }
}

async function stopLiveBroadcast() {
  cleanupLiveConnection();

  if (state.liveBroadcastId) {
    try {
      await api(`/api/videos/${encodeURIComponent(state.liveBroadcastId)}/stop-live`, { method: "POST" });
      state.notice = "Live broadcast ended.";
      delete state.liveFrameByVideo[state.liveBroadcastId];
    } catch (error) {
      state.notice = error.message;
    }
  }

  if (runtime.cameraStream) {
    runtime.cameraStream.getTracks().forEach((track) => track.stop());
    runtime.cameraStream = null;
  }

  if (runtime.captureVideo) {
    runtime.captureVideo.pause();
    runtime.captureVideo.srcObject = null;
    runtime.captureVideo = null;
  }

  state.liveBroadcastId = "";
  state.liveCameraEnabled = false;
  await refreshAppData();
  render();
}

async function startLiveChatStream(videoId) {
  stopLiveChatStream();

  runtime.liveChatVideoId = videoId;

  try {
    const source = new EventSource(`/api/videos/${encodeURIComponent(videoId)}/chat/stream`, {
      withCredentials: true,
    });
    runtime.liveChatSource = source;
    runtime.liveChatVideoId = videoId;

    source.addEventListener("chat", (event) => {
      try {
        const payload = JSON.parse(event.data);
        const existing = state.liveChatMessagesByVideo[videoId] || [];
        const next = [...existing, payload];
        if (next.length > 200) {
          next.splice(0, next.length - 200);
        }
        state.liveChatMessagesByVideo[videoId] = next;
        render();
      } catch (error) {
        console.error("Live chat parse error:", error);
      }
    });

    source.addEventListener("viewer-count", (event) => {
      try {
        const payload = JSON.parse(event.data);
        state.liveViewerCounts[payload.videoId] = payload.count;
        render();
      } catch (error) {
        console.error("Viewer count parse error:", error);
      }
    });

    source.addEventListener("frame", (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.videoId && payload.frame) {
          state.liveFrameByVideo[payload.videoId] = payload.frame;
          syncLiveImageElement(payload.videoId);
        }
      } catch (error) {
        console.error("Live frame parse error:", error);
      }
    });

    source.onerror = () => {
      console.error("Live chat stream closed.");
    };
    await loadLiveChatHistory(videoId).catch(() => {});
  } catch (error) {
    console.error("Failed to start live chat:", error);
    stopLiveChatStream();
  }
}

function stopLiveChatStream() {
  if (runtime.liveChatSource) {
    runtime.liveChatSource.close();
    runtime.liveChatSource = null;
  }
  runtime.liveChatVideoId = "";
}
// ======================================================
//  LIVE STREAMING HELPERS (FRAME + WEBRTC VIEWER)
// ======================================================

// Keep this for compatibility with old live-frame system
async function pushLiveFrame(videoId) {
  const source = runtime.captureVideo;
  if (!source || !runtime.cameraStream || runtime.liveFrameUploadInFlight) return;

  const canvas = document.createElement("canvas");
  const sourceWidth = source.videoWidth || 960;
  const sourceHeight = source.videoHeight || 540;
  const scale = Math.min(1, 960 / sourceWidth);
  canvas.width = Math.max(480, Math.round(sourceWidth * scale));
  canvas.height = Math.max(270, Math.round(sourceHeight * scale));
  const context = canvas.getContext("2d");
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  const frame = canvas.toDataURL("image/webp", 0.62);
  runtime.liveFrameUploadInFlight = true;
  try {
    state.liveFrameByVideo[videoId] = frame;
    syncLiveImageElement(videoId);
    await api(`/api/videos/${encodeURIComponent(videoId)}/frame`, {
      method: "POST",
      body: { current_frame_url: frame },
    });
  } finally {
    runtime.liveFrameUploadInFlight = false;
  }
}

async function startLiveViewer(videoId) {
  stopLiveViewer();
  runtime.viewerVideoId = videoId;
  const video = state.videos.find((entry) => entry.id === videoId);
  if (video && video.current_frame_url) {
    state.liveFrameByVideo[videoId] = video.current_frame_url;
  }
  syncLiveImageElement(videoId);

  runtime.viewerPeerId = cryptoRandomId();
  const audioEl = document.getElementById("live-audio");
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });
  runtime.viewerPC = pc;

  pc.ontrack = (event) => {
    if (!audioEl) return;
    audioEl.srcObject = event.streams[0];
    audioEl.volume = 1;
    connectLiveAudioStream(audioEl, event.streams[0]);
    audioEl.play().catch(() => {});
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      api(`/api/videos/${videoId}/signal`, {
        method: "POST",
        body: { type: "candidate", candidate: event.candidate, source: "viewer", peer_id: runtime.viewerPeerId },
      }).catch(() => {});
    }
  };

  await api(`/api/videos/${videoId}/signal`, {
    method: "POST",
    body: { type: "viewer-ready", source: "viewer", peer_id: runtime.viewerPeerId },
  });

  const pendingCandidates = [];
  const pollSignals = async () => {
    try {
      const { signals = [] } = await api(`/api/videos/${videoId}/signal?for=viewer&peer_id=${encodeURIComponent(runtime.viewerPeerId)}`);
      for (const signal of signals) {
        if (signal.type === "offer" && signal.offer && !pc.currentRemoteDescription) {
          await pc.setRemoteDescription(new RTCSessionDescription(signal.offer));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await api(`/api/videos/${videoId}/signal`, {
            method: "POST",
            body: { type: "answer", answer, source: "viewer", peer_id: runtime.viewerPeerId },
          });
          for (const candidate of pendingCandidates) {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
          }
          pendingCandidates.length = 0;
        }
        if (signal.type === "candidate" && signal.candidate) {
          if (pc.currentRemoteDescription) {
            await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
          } else {
            pendingCandidates.push(signal.candidate);
          }
        }
      }
    } catch (error) {
      console.error("Viewer audio signal poll error:", error);
    }
  };

  await pollSignals();
  runtime.viewerPoll = window.setInterval(pollSignals, 1000);
}

function stopLiveViewer() {
  const videoId = runtime.viewerVideoId;
  const peerId = runtime.viewerPeerId;
  if (runtime.viewerPoll) {
    clearInterval(runtime.viewerPoll);
    runtime.viewerPoll = null;
  }
  if (runtime.viewerPC) {
    runtime.viewerPC.close();
    runtime.viewerPC = null;
  }
  disconnectLiveAudioStream();
  runtime.viewerVideoId = "";
  runtime.viewerPeerId = "";
  const audioEl = document.getElementById("live-audio");
  if (audioEl) {
    audioEl.pause();
    audioEl.srcObject = null;
  }
  if (videoId && peerId && state.user) {
    api(`/api/videos/${encodeURIComponent(videoId)}/signal`, {
      method: "POST",
      body: { type: "viewer-left", source: "viewer", peer_id: peerId },
    }).catch(() => {});
  }
}

function syncLiveViewer() {
  if (!state.user || state.route.name !== "watch") {
    stopLiveViewer();
    return;
  }
  const video = state.videos.find((entry) => entry.id === state.route.params.id);
  if (!video || !video.is_live) {
    stopLiveViewer();
    return;
  }
  if (runtime.viewerVideoId === video.id && runtime.viewerPC) {
    syncLiveImageElement(video.id);
    return;
  }
  void startLiveViewer(video.id).catch((error) => console.error("Live viewer failed:", error));
}

function syncLiveImageElement(videoId) {
  const imageEl = document.getElementById("live-player");
  const frame = state.liveFrameByVideo[videoId];
  if (!imageEl || !frame) return;
  if (imageEl.tagName === "IMG" && imageEl.getAttribute("src") !== frame) {
    imageEl.setAttribute("src", frame);
  }
}

function cryptoRandomId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return `peer_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

function connectLiveAudioStream(audioEl, stream) {
  disconnectLiveAudioStream();
  if (!stream) return;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  try {
    const context = new AudioContextClass();
    const source = context.createMediaStreamSource(stream);
    const gain = context.createGain();
    gain.gain.value = 1.9;
    source.connect(gain);
    gain.connect(context.destination);
    runtime.viewerAudioContext = context;
    runtime.viewerAudioSource = source;
    runtime.viewerAudioGain = gain;
    if (context.state === "suspended") {
      context.resume().catch(() => {});
    }
    audioEl.muted = true;
  } catch (error) {
    console.error("Audio boost setup failed:", error);
    audioEl.muted = false;
  }
}

function disconnectLiveAudioStream() {
  if (runtime.viewerAudioSource) {
    runtime.viewerAudioSource.disconnect();
    runtime.viewerAudioSource = null;
  }
  if (runtime.viewerAudioGain) {
    runtime.viewerAudioGain.disconnect();
    runtime.viewerAudioGain = null;
  }
  if (runtime.viewerAudioContext) {
    runtime.viewerAudioContext.close().catch(() => {});
    runtime.viewerAudioContext = null;
  }
}


function render() {
  if (!state.user && state.route.name !== "login" && state.route.name !== "signup") {
    root.innerHTML = renderEducationHomepage();
  } else if (state.user) {
    root.innerHTML = renderShell();
  } else {
    root.innerHTML = renderPublicPage();
  }
  syncLivePreview();
  syncBackgroundEffects();
  syncLiveViewer();
  syncLiveChatStream();
}

function renderEducationHomepage() {
  const darkMode = getTheme() === "dark";
  const pageClass = darkMode
    ? "min-h-screen bg-slate-950 text-slate-100"
    : "min-h-screen bg-gradient-to-b from-slate-50 via-white to-slate-100 text-slate-900";
  const headerClass = darkMode
    ? "sticky top-0 z-50 border-b border-slate-800/80 bg-slate-950/90 backdrop-blur"
    : "sticky top-0 z-50 border-b border-slate-200/80 bg-white/90 backdrop-blur";
  const surfaceClass = darkMode ? "bg-slate-900" : "bg-white";
  const softSurfaceClass = darkMode ? "bg-slate-800/70" : "bg-slate-50";
  const borderClass = darkMode ? "border-slate-800" : "border-slate-200";
  const mutedTextClass = darkMode ? "text-slate-300" : "text-slate-600";
  const headingClass = darkMode ? "text-white" : "text-slate-900";
  const subTextClass = darkMode ? "text-slate-400" : "text-slate-500";

  return `
    <div class="${pageClass}">
      <header class="${headerClass}">
        <div class="mx-auto flex max-w-[1800px] items-center justify-between gap-4 px-4 py-4 md:px-8">
          <div class="flex items-center gap-3">
            <div class="flex h-10 w-10 items-center justify-center rounded-2xl bg-blue-600 text-white shadow-lg shadow-blue-600/20">
              ${iconSpark("h-5 w-5")}
            </div>
            <div>
              <p class="text-sm font-semibold tracking-[0.2em] text-blue-700 uppercase ${darkMode ? "dark:text-blue-300" : ""}">Northstar Math Academy</p>
              <p class="text-xs ${subTextClass}">Clear lessons, steady practice, stronger results</p>
            </div>
          </div>
          <nav class="hidden items-center gap-2 md:flex">
            ${["Home", "Lessons", "Practice", "Resources", "About"].map((label) => `
              <button
                class="rounded-full px-4 py-2 text-sm font-medium ${darkMode ? "text-slate-300 hover:bg-slate-800 hover:text-white" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"} transition"
                type="button"
                data-action="scroll-section"
                data-section="${label.toLowerCase()}"
              >
                ${label}
              </button>
            `).join("")}
          </nav>
          <div class="flex items-center gap-2">
            ${renderThemeToggleButton()}
            <button class="inline-flex items-center justify-center rounded-md border ${darkMode ? "border-slate-700 bg-slate-800 text-slate-100 hover:bg-slate-700" : "border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100"} px-4 py-2.5 text-sm font-medium" data-route="/login" type="button">
              Enter MyTube
            </button>
          </div>
        </div>
      </header>

      <main class="mx-auto max-w-[1800px] px-4 pb-16 pt-6 md:px-8 md:pt-10">
        <section id="home" class="overflow-hidden rounded-[2rem] border ${borderClass} ${surfaceClass} shadow-[0_24px_80px_rgba(15,23,42,0.08)]">
          <div class="grid gap-10 px-6 py-10 md:px-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-center lg:px-12 lg:py-14">
            <div class="max-w-2xl">
              <div class="inline-flex items-center gap-2 rounded-full border ${darkMode ? "border-blue-900/60 bg-blue-950/50 text-blue-300" : "border-blue-200 bg-blue-50 text-blue-700"} px-3 py-1 text-xs font-medium">
                ${iconSpark("h-4 w-4")}
                Guided learning for algebra, geometry, and beyond
              </div>
              <h1 class="mt-5 text-4xl font-bold tracking-tight ${headingClass} md:text-6xl">
                Learn math with structure, confidence, and everyday practice.
              </h1>
              <p class="mt-5 max-w-xl text-lg leading-8 ${mutedTextClass}">
                Explore lessons that break down difficult ideas, practice sets that build fluency, and resources that make each step easier to understand.
              </p>
              <div class="mt-8 flex flex-col gap-3 sm:flex-row">
                <button class="inline-flex items-center justify-center rounded-md ${darkMode ? "bg-blue-500 hover:bg-blue-400" : "bg-blue-600 hover:bg-blue-700"} px-4 py-2.5 text-sm font-medium text-white" data-route="/login" type="button">
                  Enter MyTube
                </button>
                <button class="inline-flex items-center justify-center rounded-md border ${darkMode ? "border-slate-700 bg-slate-800 text-slate-100 hover:bg-slate-700" : "border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100"} px-4 py-2.5 text-sm font-medium" type="button" data-action="scroll-section" data-section="lessons">
                  Explore Lessons
                </button>
              </div>
              <div class="mt-10 grid gap-4 sm:grid-cols-3">
                ${[
                  ["Lesson pace", "Small steps that build into full understanding."],
                  ["Practice focus", "Repetition with purpose, not noise."],
                  ["Ready resources", "Reference sheets, examples, and review tools."],
                ].map(([title, text]) => `
                  <div class="rounded-2xl border ${borderClass} ${softSurfaceClass} p-4">
                    <p class="text-sm font-semibold ${headingClass}">${title}</p>
                    <p class="mt-2 text-sm leading-6 ${mutedTextClass}">${text}</p>
                  </div>
                `).join("")}
              </div>
            </div>

            <div class="grid gap-4">
              <div class="rounded-[1.75rem] border ${borderClass} ${softSurfaceClass} p-5">
                <div class="flex items-center justify-between">
                  <p class="text-sm font-semibold ${headingClass}">Worked Example</p>
                  <span class="rounded-full ${darkMode ? "bg-blue-950/70 text-blue-300" : "bg-blue-100 text-blue-700"} px-3 py-1 text-xs font-medium">Algebra</span>
                </div>
                <div class="mt-5 rounded-2xl ${surfaceClass} p-5 shadow-sm">
                  <p class="text-sm ${subTextClass}">Solve for <span class="font-semibold ${headingClass}">x</span>:</p>
                  <div class="mt-4 space-y-3 text-lg font-semibold ${headingClass}">
                    <div>2x + 8 = 20</div>
                    <div class="${darkMode ? "text-blue-300" : "text-blue-600"}">2x = 12</div>
                    <div class="${darkMode ? "text-emerald-300" : "text-emerald-600"}">x = 6</div>
                  </div>
                </div>
              </div>
              ${renderMathDiagram()}
            </div>
          </div>
        </section>

        <section id="lessons" class="mt-8 grid gap-6 lg:grid-cols-3">
          ${[
            ["Lessons", "Short, focused explanations for algebra, geometry, fractions, and problem solving.", iconBook("h-5 w-5")],
            ["Practice", "Timed drills, review sets, and guided problem solving to strengthen retention.", iconCheck("h-5 w-5")],
            ["Resources", "Formula sheets, diagrams, and class-friendly references you can return to anytime.", iconShield("h-5 w-5")],
          ].map(([title, text, icon]) => `
            <article class="rounded-[1.75rem] border ${borderClass} ${surfaceClass} p-6 shadow-sm">
              <div class="flex h-11 w-11 items-center justify-center rounded-2xl ${darkMode ? "bg-blue-950/60 text-blue-300" : "bg-blue-50 text-blue-700"}">${icon}</div>
              <h2 class="mt-5 text-2xl font-bold ${headingClass}">${title}</h2>
              <p class="mt-3 text-sm leading-7 ${mutedTextClass}">${text}</p>
            </article>
          `).join("")}
        </section>

        <section id="practice" class="mt-8 grid gap-6 lg:grid-cols-[0.95fr_1.05fr]">
          <div class="rounded-[1.75rem] border ${borderClass} ${surfaceClass} p-6">
            <p class="text-xs font-semibold uppercase tracking-[0.25em] ${darkMode ? "text-blue-300" : "text-blue-700"}">Practice</p>
            <h2 class="mt-3 text-3xl font-bold ${headingClass}">Turn concepts into confidence.</h2>
            <p class="mt-4 text-sm leading-7 ${mutedTextClass}">
              Use step-by-step drills to check understanding, revisit missed ideas, and build speed with familiar problem types.
            </p>
            <div class="mt-6 space-y-3">
              ${[
                "Evaluate expressions with order of operations",
                "Graph lines using slope and intercept",
                "Find area, perimeter, and volume with unit checks",
              ].map((item) => `
                <div class="flex items-start gap-3 rounded-2xl ${softSurfaceClass} p-4">
                  <div class="mt-0.5 rounded-full ${darkMode ? "bg-blue-950/70 text-blue-300" : "bg-blue-100 text-blue-700"} p-1">${iconCheck("h-4 w-4")}</div>
                  <p class="text-sm ${darkMode ? "text-slate-200" : "text-slate-700"}">${item}</p>
                </div>
              `).join("")}
            </div>
          </div>
          <div class="rounded-[1.75rem] border ${borderClass} ${darkMode ? "bg-gradient-to-br from-slate-900 to-slate-800" : "bg-gradient-to-br from-slate-50 to-blue-50"} p-6">
            <p class="text-xs font-semibold uppercase tracking-[0.25em] ${subTextClass}">Equation Corner</p>
            <div class="mt-5 grid gap-4 md:grid-cols-2">
              <div class="rounded-2xl ${surfaceClass} p-5 shadow-sm">
                <p class="text-sm ${subTextClass}">Linear function</p>
                <p class="mt-3 text-2xl font-bold ${headingClass}">f(x) = mx + b</p>
                <p class="mt-2 text-sm ${mutedTextClass}">Slope controls the rise, and b sets the starting point.</p>
              </div>
              <div class="rounded-2xl ${surfaceClass} p-5 shadow-sm">
                <p class="text-sm ${subTextClass}">Pythagorean theorem</p>
                <p class="mt-3 text-2xl font-bold ${headingClass}">a² + b² = c²</p>
                <p class="mt-2 text-sm ${mutedTextClass}">A classic relationship for right triangles.</p>
              </div>
              <div class="rounded-2xl ${surfaceClass} p-5 shadow-sm">
                <p class="text-sm ${subTextClass}">Area of a circle</p>
                <p class="mt-3 text-2xl font-bold ${headingClass}">A = πr²</p>
                <p class="mt-2 text-sm ${mutedTextClass}">Measure radius first, then square it.</p>
              </div>
              <div class="rounded-2xl ${surfaceClass} p-5 shadow-sm">
                <p class="text-sm ${subTextClass}">Fraction focus</p>
                <p class="mt-3 text-2xl font-bold ${headingClass}">3/4 + 1/8 = 7/8</p>
                <p class="mt-2 text-sm ${mutedTextClass}">Find a common denominator before combining parts.</p>
              </div>
            </div>
          </div>
        </section>

        <section id="resources" class="mt-8 grid gap-6 md:grid-cols-3">
          ${[
            ["Formula sheet", "A quick reference for key identities, units, and common conversions."],
            ["Graph paper", "Use coordinate grids to plot points and compare patterns."],
            ["Review guide", "A simple checklist for test prep and lesson recap."],
          ].map(([title, text]) => `
            <article class="rounded-[1.75rem] border ${borderClass} ${surfaceClass} p-6">
              <p class="text-lg font-semibold ${headingClass}">${title}</p>
              <p class="mt-3 text-sm leading-7 ${mutedTextClass}">${text}</p>
            </article>
          `).join("")}
        </section>

        <section id="about" class="mt-8 rounded-[1.75rem] border ${borderClass} ${surfaceClass} p-6 md:p-8">
          <div class="grid gap-6 lg:grid-cols-[1.05fr_0.95fr] lg:items-center">
            <div>
              <p class="text-xs font-semibold uppercase tracking-[0.25em] ${darkMode ? "text-blue-300" : "text-blue-700"}">About</p>
              <h2 class="mt-3 text-3xl font-bold ${headingClass}">A calm place to study math, one idea at a time.</h2>
              <p class="mt-4 max-w-2xl text-sm leading-7 ${mutedTextClass}">
                The structure is intentionally simple: clear explanations, useful examples, and practice that reinforces what was just learned. It is designed to feel academic, organized, and easy to navigate.
              </p>
            </div>
            <div class="grid gap-4 sm:grid-cols-2">
              ${[
                ["Home", "A starting point for the day’s work."],
                ["Lessons", "Learn concepts with step-by-step clarity."],
                ["Practice", "Build fluency through repeated problem solving."],
                ["Resources", "Keep the tools you need close at hand."],
              ].map(([title, text]) => `
                <div class="rounded-2xl border ${borderClass} ${softSurfaceClass} p-4">
                  <p class="font-semibold ${headingClass}">${title}</p>
                  <p class="mt-2 text-sm ${mutedTextClass}">${text}</p>
                </div>
              `).join("")}
            </div>
          </div>
        </section>

        <footer class="flex flex-col items-start justify-between gap-4 px-1 pt-8 sm:flex-row sm:items-center">
          <p class="text-sm ${subTextClass}">Built for focused, school-safe math study.</p>
          <button class="inline-flex items-center justify-center rounded-md ${darkMode ? "bg-blue-500 hover:bg-blue-400" : "bg-blue-600 hover:bg-blue-700"} px-4 py-2.5 text-sm font-medium text-white" data-route="/login" type="button">
            Enter MyTube
          </button>
        </footer>
      </main>
    </div>
  `;
}

function renderPublicPage() {
  if (state.route.name === "signup") {
    return renderAuthLayout({
      title: "Create your MyTube account",
      subtitle: "Welcome to MyTube! Let's start by creating your account.",
      form: `
        <form data-signup-form class="space-y-4">
          <div>
            <label class="text-sm font-medium">Full name</label>
            <input class="${inputClass()}" name="full_name" placeholder="John Doe" required />
          </div>
          <div>
            <label class="text-sm font-medium">Channel name</label>
            <input class="${inputClass()}" name="channel_name" placeholder="John Doe's Channel" />
          </div>
          <div>
            <label class="text-sm font-medium">Email</label>
            <input class="${inputClass()}" type="email" name="email" placeholder="you@mytube.co" required />
          </div>
          <div>
            <label class="text-sm font-medium">Password</label>
            <input class="${inputClass()}" type="password" name="password" placeholder="Create a password" required />
          </div>
          ${renderMessage()}
          <button class="${primaryButtonClass("w-full")}" type="submit" ${state.authLoading ? "disabled" : ""}>
            ${state.authLoading ? "Creating account..." : "Create Account"}
          </button>
        </form>
        <p class="mt-6 text-sm text-muted-foreground">
          Already have an account?
          <button class="text-primary hover:underline" data-route="/login" type="button">Sign in</button>
        </p>
      `,
    });
  }

  return renderAuthLayout({
    title: "Login to MyTube",
    subtitle: "Use one of your local accounts or create a new one.",
    form: `
      <form data-login-form class="space-y-4">
        <div>
          <label class="text-sm font-medium">Email</label>
          <input class="${inputClass()}" type="email" name="email" placeholder="sjordan4076@mytube.co" required />
        </div>
        <div>
          <label class="text-sm font-medium">Password</label>
          <input class="${inputClass()}" type="password" name="password" placeholder="Your password" required />
        </div>
        ${renderMessage()}
        <button class="${primaryButtonClass("w-full")}" type="submit" ${state.authLoading ? "disabled" : ""}>
          ${state.authLoading ? "Signing in..." : "Sign In"}
        </button>
      </form>
      <p class="mt-6 text-sm text-muted-foreground">
        Need an account?
        <button class="text-primary hover:underline" data-route="/signup" type="button">Create one</button>
      </p>
    `,
  });
}

function renderShell() {
  const sidebarWidth = state.sidebarCollapsed ? "w-[72px]" : "w-56";
  const contentOffset = state.sidebarCollapsed ? "ml-[72px]" : "ml-56";

  return `
    <div class="min-h-screen bg-background text-foreground">
      ${renderHeader()}
      <aside class="fixed top-14 left-0 bottom-0 ${sidebarWidth} max-md:w-[72px] bg-background z-40 overflow-y-auto transition-all duration-200 border-r border-border">
        ${renderSidebar()}
      </aside>
      <main class="pt-14 ${contentOffset} max-md:ml-[72px] transition-all duration-200">
        ${renderFlashNotice()}
        ${state.loading ? renderLoadingState() : renderPage()}
      </main>
    </div>
  `;
}

function renderHeader() {
  return `
    <header class="fixed top-0 left-0 right-0 z-50 bg-background/95 backdrop-blur-md border-b border-border h-14 flex items-center px-4 gap-2">
      <button class="inline-flex h-10 w-10 items-center justify-center rounded-md hover:bg-accent" data-action="toggle-sidebar" aria-label="Toggle sidebar">
        ${iconMenu("h-5 w-5")}
      </button>

      <button class="flex items-center gap-2 shrink-0 mr-2" data-route="/">
        <div class="bg-primary rounded-lg p-1">${iconVideo("h-5 w-5 text-primary-foreground")}</div>
        <span class="font-bold text-lg hidden sm:inline">MyTube</span>
      </button>

      <form data-search-form class="hidden md:flex flex-1 max-w-xl mx-auto">
        <div class="flex w-full">
          <input class="${inputClass("rounded-r-none")}" name="query" placeholder="Search videos..." value="${escapeHtml(state.route.query.q || state.searchInput)}" />
          <button class="inline-flex h-10 items-center justify-center rounded-r-md border border-l-0 border-border bg-secondary px-5 hover:bg-accent" type="submit">
            ${iconSearch("h-4 w-4")}
          </button>
        </div>
      </form>

      <div class="flex-1 md:hidden"></div>
      ${renderThemeToggleButton()}
      <div class="hidden sm:flex items-center gap-3 rounded-full bg-secondary px-3 py-1.5">
        <div class="h-8 w-8 rounded-full bg-primary flex items-center justify-center text-primary-foreground font-semibold text-sm">
          ${escapeHtml((state.user.full_name || state.user.email || "U").charAt(0).toUpperCase())}
        </div>
        <div class="text-left">
          <p class="text-sm font-medium leading-none">${escapeHtml(state.user.full_name || "User")}</p>
          <p class="text-xs text-muted-foreground mt-1">${escapeHtml(state.user.email)}</p>
        </div>
      </div>
      ${state.user.role === "admin" ? `<button class="${secondaryButtonClass()}" data-route="/admin">Admin</button>` : ""}
      <button class="${secondaryButtonClass()}" data-action="logout">Logout</button>
    </header>
  `;
}

function renderSidebar() {
  const sections = [...sidebarSections];
  if (state.user.role === "admin") {
    sections.push({
      title: "Moderation",
      items: [{ label: "Admin Panel", route: "/admin" }],
    });
  }

  return sections
    .map((section, index) => {
      const title = state.sidebarCollapsed
        ? ""
        : section.title
          ? `<p class="px-3 py-1 text-xs font-semibold text-muted-foreground uppercase tracking-wider">${escapeHtml(section.title)}</p>`
          : "";

      const items = section.items
        .map((item) => {
          const active =
            state.route.path === item.route ||
            (item.route === "/channel" && state.route.name === "channel-detail");
          return `
            <button class="w-full flex items-center gap-4 px-3 py-2.5 rounded-lg transition-colors text-sm ${
              active ? "bg-accent text-foreground font-medium" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            } ${state.sidebarCollapsed ? "justify-center px-2" : ""}" data-route="${item.route}">
              ${navIcon(item.label)}
              ${state.sidebarCollapsed ? "" : `<span class="truncate">${escapeHtml(item.label)}</span>`}
            </button>
          `;
        })
        .join("");

      return `
        <div class="py-${index === 0 ? "2" : "1"} px-2 space-y-1">
          ${title}
          ${items}
        </div>
        ${
          index < sections.length - 1 && !state.sidebarCollapsed
            ? '<div class="mx-4 my-2 border-t border-border"></div>'
            : ""
        }
      `;
    })
    .join("");
}

function renderPage() {
  switch (state.route.name) {
    case "home":
      return renderFeedPage("Home", "Latest uploads from your standalone backend.", getSortedVideos("latest"));
    case "trending":
      return renderFeedPage("Trending", "Most watched and liked videos right now.", getSortedVideos("trending"));
    case "subscriptions":
      return renderFeedPage(
        "Subscriptions",
        "Videos from channels you follow.",
        state.videos.filter((video) => (state.user.subscribed_channels || []).includes(video.channel_name)),
        { showCreate: false },
      );
    case "search":
      return renderSearchPage();
    case "watch":
      return renderWatchPage();
    case "upload":
      return renderUploadPage(false);
    case "go-live":
      return renderUploadPage(true);
    case "profile":
      return renderProfilePage();
    case "channel":
      return renderChannelPage(state.user.channel_name);
    case "channel-detail":
      return renderChannelPage(state.route.params.channel);
    case "music":
      return renderFeedPage("MyTube Music", "Music uploads from your local platform.", state.videos.filter((video) => video.is_music));
    case "live":
      return renderFeedPage(
        "MyTube Live",
        "Current and recent live streams.",
        state.videos.filter((video) => video.is_live),
        {
          createRoute: "/go-live",
          createLabel: "Go Live",
          emptyText: "No live streams are running right now. Start your camera broadcast from Go Live.",
        }
      );
    case "stock":
      return renderStockPage();
    case "sports":
      return renderSportsPage();
    case "liked":
      return renderFeedPage(
        "Liked Videos",
        "Everything you’ve liked.",
        orderedVideosByIds(state.user.liked_video_ids || []),
        { showCreate: false },
      );
    case "history":
      return renderFeedPage(
        "History",
        "Videos you recently watched.",
        orderedVideosByIds(state.user.history_video_ids || []),
        { showCreate: false },
      );
    case "admin":
      return renderAdminPage();
    default:
      return renderEmptyState("Page not found", "This route does not exist in the standalone build.");
  }
}

function syncLiveChatStream() {
  if (state.route.name !== "watch") {
    stopLiveChatStream();
    return;
  }
  const video = state.videos.find((entry) => entry.id === state.route.params.id);
  if (!video || !video.is_live) {
    stopLiveChatStream();
    return;
  }
  if (runtime.liveChatVideoId === video.id && runtime.liveChatSource) {
    return;
  }
  void startLiveChatStream(video.id);
}

function renderFeedPage(title, description, videos, options = {}) {
  const showCreate = options.showCreate !== false;
  const createRoute = options.createRoute || "/upload";
  const createLabel = options.createLabel || "Upload";
  const createIcon = createLabel === "Go Live" ? iconLive("h-4 w-4 mr-2") : iconUpload("h-4 w-4 mr-2");
  const emptyText = options.emptyText || `${title} is empty right now. Upload a video or create a live stream to populate this page.`;
  return `
    <div>
      <section class="relative overflow-hidden border-b border-border">
        <div class="absolute inset-0 bg-gradient-to-r from-primary/10 via-transparent to-red-500/10"></div>
        <div class="relative p-6 md:p-8 max-w-[1800px] mx-auto">
          <div class="flex flex-col xl:flex-row xl:items-end xl:justify-between gap-6">
            <div>
              <div class="inline-flex items-center gap-2 rounded-full border border-border bg-card/80 px-3 py-1 text-xs text-muted-foreground">
                ${iconSpark("h-4 w-4 text-primary")}
                Standalone Backend
              </div>
              <h1 class="mt-4 text-3xl md:text-4xl font-bold">${escapeHtml(title)}</h1>
              <p class="mt-2 text-muted-foreground text-lg max-w-2xl">${escapeHtml(description)}</p>
            </div>
            <div class="flex gap-3">
              ${showCreate ? `<button class="${primaryButtonClass()}" data-route="${escapeAttr(createRoute)}">${createIcon}${escapeHtml(createLabel)}</button>` : ""}
              <button class="${secondaryButtonClass()}" data-action="refresh-data">${iconRefresh("h-4 w-4 mr-2")}Refresh</button>
            </div>
          </div>
        </div>
      </section>

      <div class="p-4 md:p-6 max-w-[1800px] mx-auto">
        ${renderVideoGrid(videos, emptyText)}
      </div>
    </div>
  `;
}

function renderSearchPage() {
  const query = String(state.route.query.q || "").trim().toLowerCase();
  const videos = query
    ? state.videos.filter((video) =>
        [video.title, video.description, video.channel_name, ...(video.tags || [])]
          .join(" ")
          .toLowerCase()
          .includes(query),
      )
    : [];

  return `
    <div class="max-w-[1800px] mx-auto p-4 md:p-8">
      <h1 class="text-3xl font-bold">Search</h1>
      <p class="text-muted-foreground mt-2">
        ${query ? `Showing results for "${escapeHtml(state.route.query.q || "")}"` : "Use the search bar above to find videos."}
      </p>
      <div class="mt-8">
        ${renderVideoGrid(videos, query ? "No videos matched that search." : "Search is ready. Type a query to start browsing.")}
      </div>
    </div>
  `;
}

function renderStockPage() {
  const selectedStock = state.stocks.find((stock) => stock.symbol === state.selectedStockSymbol) || state.stocks[0] || null;
  const selectedSeries = selectedStock
    ? (state.stockHistoryBySymbol[selectedStock.symbol]?.[state.stockChartRange] || [])
    : [];
  return `
    <div class="max-w-[1800px] mx-auto p-4 md:p-8">
      <div class="flex flex-col md:flex-row md:items-end md:justify-between gap-4 mb-8">
        <div>
          <h1 class="text-3xl font-bold">MyTube Stock</h1>
          <p class="text-muted-foreground mt-2">Live market quotes updating automatically from real stock data.</p>
          ${state.stocksUpdatedAt ? `<p class="text-xs text-muted-foreground mt-2">Last updated: ${escapeHtml(new Date(state.stocksUpdatedAt).toLocaleTimeString())}</p>` : ""}
        </div>
        <button class="${secondaryButtonClass()}" data-action="refresh-data">${iconRefresh("h-4 w-4 mr-2")}Refresh App</button>
      </div>

      <section class="rounded-3xl border border-border bg-card p-5 md:p-6">
        <div class="flex flex-col xl:flex-row xl:items-start xl:justify-between gap-6">
          <div>
            <p class="text-xs uppercase tracking-[0.3em] text-muted-foreground">Interactive Chart</p>
            <h2 class="mt-2 text-2xl font-bold">${escapeHtml(selectedStock?.shortName || selectedStock?.symbol || "Select a stock")}</h2>
            <p class="mt-2 text-sm text-muted-foreground">
              ${selectedStock ? `${escapeHtml(selectedStock.symbol)} is currently at $${Number(selectedStock.price || 0).toFixed(2)}.` : "Choose a stock below to see its chart."}
            </p>
          </div>
          <div class="flex flex-wrap gap-2">
            ${["day", "week", "month", "year"].map((range) => `
              <button
                class="${state.stockChartRange === range ? primaryButtonClass() : secondaryButtonClass()}"
                data-action="set-stock-range"
                data-range="${range}"
                type="button"
              >${capitalize(range)}</button>
            `).join("")}
          </div>
        </div>
        <div class="mt-6">
          ${renderStockChart(selectedStock, selectedSeries)}
        </div>
        <div class="mt-5 flex flex-wrap gap-2">
          ${state.stocks.map((stock) => `
            <button
              class="${state.selectedStockSymbol === stock.symbol ? primaryButtonClass() : secondaryButtonClass()}"
              data-action="select-stock"
              data-symbol="${escapeAttr(stock.symbol)}"
              type="button"
            >${escapeHtml(stock.symbol)}</button>
          `).join("")}
        </div>
      </section>

      <div class="grid md:grid-cols-2 xl:grid-cols-4 gap-4">
        ${
          state.stocks.length
            ? state.stocks.map((stock) => renderStockCard(stock)).join("")
            : Array.from({ length: 4 }, () => `<div class="rounded-2xl border border-border bg-card p-5 text-muted-foreground">Loading live quotes...</div>`).join("")
        }
      </div>

      <section class="mt-10">
        <h2 class="text-xl font-semibold mb-4">Stock-related videos</h2>
        ${renderVideoGrid(
          state.videos.filter((video) => video.category === "stock" || (video.tags || []).includes("stock")),
          "No stock videos yet. Upload one if you want finance content here.",
        )}
      </section>
    </div>
  `;
}

function renderSportsPage() {
  const sportsVideos = state.videos.filter((video) => {
    const tags = Array.isArray(video.tags) ? video.tags : [];
    return Boolean(video.is_sports || video.category === "sports" || tags.includes("sports"));
  });

  return renderFeedPage(
    "MyTube Sports",
    "Sports uploads from your local platform.",
    sportsVideos,
    {
      createRoute: "/upload?category=sports",
      createLabel: "Upload Sports",
      emptyText: "No sports uploads yet. Post a sports video to populate this page.",
    },
  );
}

function renderWatchPage() {
  const video = state.videos.find((entry) => entry.id === state.route.params.id);
  if (!video) {
    return renderEmptyState("Video not found", "This video may have been removed.");
  }

  const related = state.videos.filter((entry) => entry.id !== video.id).slice(0, 6);
  const isLiked = (state.user.liked_video_ids || []).includes(video.id);
  const isSubscribed = (state.user.subscribed_channels || []).includes(video.channel_name);
  const isOwnChannel = state.user.channel_name === video.channel_name;
  const liveFrame = state.liveFrameByVideo[video.id] || video.current_frame_url;
  const isAudioTrack = isAudioUpload(video.video_url);
  const isSportsVideo = Boolean(video.is_sports || video.category === "sports" || (Array.isArray(video.tags) && video.tags.includes("sports")));
  const contentLabel = video.is_music
    ? "MyTube Music"
    : isSportsVideo
      ? "MyTube Sports"
      : video.category === "stock"
        ? "MyTube Stock"
        : "";

  return `
    <div class="p-4 md:p-6 max-w-[1800px] mx-auto">
      <div class="grid xl:grid-cols-[minmax(0,1fr)_360px] gap-8">
        <div>
          <div class="aspect-video rounded-3xl overflow-hidden border border-border bg-card">
  ${
    video.is_live
      ? (
        liveFrame
          ? `<div class="relative h-full w-full bg-black">
              <img id="live-player" class="h-full w-full object-cover bg-black" src="${escapeAttr(liveFrame)}" alt="${escapeAttr(video.title)}" />
              <audio id="live-audio" autoplay playsinline class="hidden"></audio>
            </div>`
          : `<div class="w-full h-full flex items-center justify-center bg-black text-muted-foreground">Waiting for live camera...</div>`
      )
      : video.video_url
        ? (isAudioTrack
            ? `<div class="h-full w-full bg-black text-white flex flex-col justify-center p-6 md:p-10">
                ${video.thumbnail_url ? `<img class="mx-auto h-48 w-48 rounded-3xl object-cover shadow-2xl" src="${escapeAttr(video.thumbnail_url)}" alt="${escapeAttr(video.title)}" />` : `<div class="mx-auto h-48 w-48 rounded-3xl bg-white/10 flex items-center justify-center">${isSportsVideo ? iconSports("h-20 w-20 text-white/75") : iconMusic("h-20 w-20 text-white/75")}</div>`}
                <div class="mx-auto mt-8 w-full max-w-2xl">
                  ${contentLabel ? `<p class="text-center text-sm uppercase tracking-[0.25em] text-white/60">${escapeHtml(contentLabel)}</p>` : ""}
                  <h2 class="mt-3 text-center text-2xl font-bold">${escapeHtml(video.title)}</h2>
                  <p class="mt-2 text-center text-white/70">${escapeHtml(video.channel_name)}</p>
                  <audio class="mt-6 w-full" src="${escapeAttr(video.video_url)}" controls preload="metadata"></audio>
                </div>
              </div>`
            : `<video class="w-full h-full object-cover bg-black" src="${escapeAttr(video.video_url)}" controls playsinline preload="metadata"></video>`)
        : video.thumbnail_url
          ? `<img class="w-full h-full object-cover" src="${escapeAttr(video.thumbnail_url)}" alt="${escapeAttr(video.title)}" />`
          : `<div class="w-full h-full flex items-center justify-center bg-secondary">${iconVideo("h-14 w-14 text-muted-foreground")}</div>`
  }
</div>

          </div>
          <h1 class="mt-5 text-2xl md:text-3xl font-bold">${escapeHtml(video.title)}</h1>
          <div class="mt-3 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            <span>${escapeHtml(video.channel_name)}</span>
            <span>${formatCount(video.views)} views</span>
            <span>${formatCount(video.likes)} likes</span>
            <span>${escapeHtml(video.duration || "0:00")}</span>
            ${contentLabel ? `<span class="rounded-full bg-secondary px-3 py-1 text-xs text-secondary-foreground">${escapeHtml(contentLabel)}</span>` : ""}
            ${video.is_live ? `<span class="rounded-full bg-red-500/15 px-3 py-1 text-xs text-red-300">LIVE</span>` : ""}
            ${video.is_live ? `<span class="rounded-full bg-emerald-500/10 px-3 py-1 text-xs text-emerald-300">${formatCount(state.liveViewerCounts[video.id] || 0)} viewing</span>` : ""}
          </div>
          <div class="mt-5 flex flex-wrap gap-3">
            <button class="${primaryButtonClass()}" data-action="like-video" data-video-id="${video.id}">
              ${iconHeart("h-4 w-4 mr-2")} ${isLiked ? "Unlike" : "Like"}
            </button>
            ${!isOwnChannel ? `<button class="${secondaryButtonClass()}" data-action="subscribe-channel" data-channel-name="${escapeAttr(video.channel_name)}">
              ${iconUsers("h-4 w-4 mr-2")} ${isSubscribed ? "Unsubscribe" : "Subscribe"}
            </button>` : ""}
            <button class="${secondaryButtonClass()}" data-action="report-video" data-video-id="${video.id}">
              ${iconFlag("h-4 w-4 mr-2")} Report
            </button>
            ${(state.user.id === video.owner_id && video.is_live)
              ? `<button class="${secondaryButtonClass()}" data-action="stop-live">${iconBroadcast("h-4 w-4 mr-2")} Stop Live</button>`
              : ""}
            ${(state.user.id === video.owner_id)
              ? `<button class="${secondaryButtonClass()}" data-action="delete-video" data-video-id="${video.id}">${iconTrash("h-4 w-4 mr-2")} Delete</button>`
              : ""}
          </div>
          <div class="mt-6 rounded-2xl border border-border bg-card p-5">
            <h2 class="font-semibold mb-2">Description</h2>
            <p class="text-muted-foreground whitespace-pre-wrap">${escapeHtml(video.description || "No description yet.")}</p>
            ${!video.video_url && !video.is_live ? `<p class="mt-4 text-sm text-amber-300">This older upload only has a thumbnail saved, so it can’t be played. Re-upload the video file to make it watchable.</p>` : ""}
            ${
              video.tags && video.tags.length
                ? `<div class="mt-4 flex flex-wrap gap-2">${video.tags
                    .map((tag) => `<span class="rounded-full bg-secondary px-3 py-1 text-xs text-muted-foreground">#${escapeHtml(tag)}</span>`)
                    .join("")}</div>`
                : ""
            }
          </div>
          ${video.is_live ? renderLiveChatPanel(video) : renderCommentSection(video)}
        </div>
        <div>
          <h2 class="text-xl font-semibold mb-4">Up Next</h2>
          <div class="space-y-4">
            ${related.length ? related.map((entry) => renderCompactVideoCard(entry)).join("") : renderMiniEmpty("No related videos yet.")}
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderUploadPage(isLive) {
  const defaultCategory = String(state.route.query.category || (isLive ? "news" : "general")).trim() || (isLive ? "news" : "general");
  if (isLive) {
    return `
      <div class="max-w-4xl mx-auto p-4 md:p-8">
        <div class="flex items-center gap-3 mb-8">
          <div class="p-2 bg-primary/10 rounded-xl">${iconLive("h-6 w-6 text-primary")}</div>
          <div>
            <h1 class="text-2xl font-bold">Go Live</h1>
            <p class="text-sm text-muted-foreground">Use your camera to broadcast live to everyone watching your stream.</p>
          </div>
        </div>

        <div class="grid lg:grid-cols-[1.2fr_.8fr] gap-6">
          <div class="rounded-3xl border border-border bg-card p-5">
            <div class="aspect-video rounded-2xl overflow-hidden bg-black flex items-center justify-center">
              ${
                state.liveCameraEnabled
                  ? '<video id="live-camera-preview" class="w-full h-full object-cover" autoplay muted playsinline></video>'
                  : `<div class="text-center text-muted-foreground px-6">${iconLive("h-12 w-12 mx-auto mb-3 text-muted-foreground")}Enable your camera to preview the live broadcast.</div>`
              }
            </div>
            <div class="mt-4 flex flex-wrap gap-3">
              <button class="${secondaryButtonClass()}" data-action="enable-camera">${iconVideo("h-4 w-4 mr-2")}Enable Camera</button>
              ${state.liveBroadcastId ? `<button class="${secondaryButtonClass()}" data-action="stop-live">${iconBroadcast("h-4 w-4 mr-2")}Stop Broadcast</button>` : ""}
            </div>
          </div>

          <form data-upload-form class="space-y-5 rounded-3xl border border-border bg-card p-6">
            <input type="hidden" name="is_live" value="true" />
            <div>
              <label class="text-sm font-medium">Stream Title</label>
              <input class="${inputClass()}" name="title" placeholder="What are you streaming today?" required />
            </div>
            <div>
              <label class="text-sm font-medium">Description</label>
              <textarea class="${textareaClass()}" name="description" placeholder="Tell viewers what the stream is about"></textarea>
            </div>
            <div>
              <label class="text-sm font-medium">Thumbnail Image</label>
              <input class="${inputClass()}" type="file" name="thumbnail_file" accept="image/*" />
            </div>
            <div class="grid md:grid-cols-2 gap-4">
              <div>
                <label class="text-sm font-medium">Category</label>
                <select class="${inputClass()}" name="category">
                  ${["news", "gaming", "music", "sports", "tech", "education", "general", "stock"]
                    .map((category) => `<option value="${category}" ${category === defaultCategory ? "selected" : ""}>${capitalize(category)}</option>`)
                    .join("")}
                </select>
              </div>
              <div>
                <label class="text-sm font-medium">Tags</label>
                <input class="${inputClass()}" name="tags" placeholder="live, webcam, creator" />
              </div>
            </div>
            <div>
              <label class="text-sm font-medium">Duration</label>
              <input class="${inputClass()}" name="duration" value="LIVE" readonly />
            </div>
            <div class="flex flex-wrap gap-5">
              <label class="inline-flex items-center gap-2 text-sm text-muted-foreground">
                <input type="checkbox" name="is_music" />
                Music content
              </label>
              <label class="inline-flex items-center gap-2 text-sm text-muted-foreground">
                <input type="checkbox" name="is_financial" />
                Financial video
              </label>
              <label class="inline-flex items-center gap-2 text-sm text-muted-foreground">
                <input type="checkbox" name="is_sports" />
                Sports content
              </label>
            </div>
            ${renderMessage()}
            <button class="${primaryButtonClass()}" type="submit" ${state.uploadLoading ? "disabled" : ""}>
              ${state.uploadLoading ? "Starting..." : state.liveBroadcastId ? "Broadcast Running" : "Start Broadcast"}
            </button>
          </form>
        </div>
      </div>
    `;
  }

  return `
    <div class="max-w-3xl mx-auto p-4 md:p-8">
      <div class="flex items-center gap-3 mb-8">
        <div class="p-2 bg-primary/10 rounded-xl">${isLive ? iconLive("h-6 w-6 text-primary") : iconUpload("h-6 w-6 text-primary")}</div>
        <div>
          <h1 class="text-2xl font-bold">${isLive ? "Go Live" : "Upload Video"}</h1>
          <p class="text-sm text-muted-foreground">${isLive ? "Create a live item that appears in MyTube Live." : "Post a new video to your local MyTube backend."}</p>
        </div>
      </div>

      <form data-upload-form class="space-y-5 rounded-3xl border border-border bg-card p-6">
        <div>
          <label class="text-sm font-medium">Title</label>
          <input class="${inputClass()}" name="title" placeholder="${isLive ? "Live stream title" : "Video title"}" required />
        </div>
        <div>
          <label class="text-sm font-medium">Description</label>
          <textarea class="${textareaClass()}" name="description" placeholder="Describe your content"></textarea>
        </div>
        <div class="grid md:grid-cols-2 gap-4">
          <div>
            <label class="text-sm font-medium">Thumbnail Image</label>
            <input class="${inputClass()}" type="file" name="thumbnail_file" accept="image/*" />
          </div>
          <div>
            <label class="text-sm font-medium">Media File</label>
            <input class="${inputClass()}" type="file" name="video_file" accept="video/mp4,video/webm,video/quicktime,.mov,audio/mpeg,.mp3" required />
          </div>
        </div>
        <div>
          <label class="text-sm font-medium">Duration</label>
          <input class="${inputClass()}" name="duration" placeholder="${isLive ? "LIVE" : "8:24"}" value="${isLive ? "LIVE" : ""}" />
        </div>
        <div class="grid md:grid-cols-2 gap-4">
          <div>
            <label class="text-sm font-medium">Category</label>
            <select class="${inputClass()}" name="category">
              ${["general", "music", "gaming", "education", "entertainment", "sports", "news", "tech", "stock"]
                .map((category) => `<option value="${category}" ${category === defaultCategory ? "selected" : ""}>${capitalize(category)}</option>`)
                .join("")}
            </select>
          </div>
          <div>
            <label class="text-sm font-medium">Tags</label>
            <input class="${inputClass()}" name="tags" placeholder="music, live, tutorial" />
          </div>
        </div>
        <div class="flex flex-wrap gap-5">
          <label class="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <input type="checkbox" name="is_music" />
            Music content
          </label>
          <label class="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <input type="checkbox" name="is_financial" />
            Financial video
          </label>
          <label class="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <input type="checkbox" name="is_sports" />
            Sports content
          </label>
        </div>
        ${renderMessage()}
        <button class="${primaryButtonClass()}" type="submit" ${state.uploadLoading ? "disabled" : ""}>
          ${state.uploadLoading ? "Saving..." : "Upload Video"}
        </button>
        <div class="rounded-2xl border border-border bg-background/60 p-4 text-sm text-muted-foreground">
          Accepted uploads: .mp4, .webm, .mov, and .mp3 for MyTube Music.
        </div>
        <div class="rounded-2xl border border-border bg-background/60 p-4 text-sm text-muted-foreground">
          Want to stream your camera live instead?
          <button class="ml-1 text-primary hover:underline" type="button" data-route="/go-live">Open Go Live</button>
        </div>
      </form>
    </div>
  `;
}

function isAudioUpload(url) {
  return /\.mp3($|\?)/i.test(String(url || ""));
}

function renderProfilePage() {
  const ownVideos = state.videos.filter((video) => video.owner_id === state.user.id);
  const liveCount = ownVideos.filter((video) => video.is_live).length;
  const musicCount = ownVideos.filter((video) => video.is_music).length;

  return `
    <div class="max-w-6xl mx-auto p-4 md:p-8">
      <div class="rounded-3xl border border-border bg-card p-6 md:p-8">
        <div class="flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div class="flex items-center gap-4">
            <div class="h-24 w-24 rounded-full bg-primary/20 flex items-center justify-center text-3xl font-bold text-primary">
              ${escapeHtml((state.user.full_name || state.user.email || "U").charAt(0).toUpperCase())}
            </div>
            <div>
              <h1 class="text-3xl font-bold">${escapeHtml(state.user.full_name || "Profile")}</h1>
              <p class="text-muted-foreground mt-2">${escapeHtml(state.user.email)}</p>
              <p class="text-sm text-muted-foreground mt-1">Channel: ${escapeHtml(state.user.channel_name)}</p>
              <p class="text-sm text-muted-foreground mt-1">Role: ${escapeHtml(state.user.role)}</p>
            </div>
          </div>
          <div class="flex flex-wrap gap-3">
            <button class="${secondaryButtonClass()}" data-route="/channel">${iconUser("h-4 w-4 mr-2")}My Channel</button>
            <button class="${secondaryButtonClass()}" data-route="/upload">${iconUpload("h-4 w-4 mr-2")}Upload</button>
            ${state.user.role === "admin" ? `<button class="${primaryButtonClass()}" data-route="/admin">${iconShield("h-4 w-4 mr-2")}Admin Panel</button>` : ""}
          </div>
        </div>
      </div>

      <div class="grid md:grid-cols-3 gap-4 mt-8">
        ${statCard("My Videos", String(ownVideos.length))}
        ${statCard("Live Streams", String(liveCount))}
        ${statCard("Music Uploads", String(musicCount))}
      </div>

      <section class="mt-8">
        <h2 class="text-xl font-semibold mb-4">My Uploads</h2>
        ${renderVideoGrid(ownVideos, "You haven’t uploaded anything yet.")}
      </section>
    </div>
  `;
}

function renderChannelPage(channelName) {
  const decoded = channelName || state.user.channel_name;
  const videos = state.videos.filter((video) => video.channel_name === decoded);
  const isOwnChannel = decoded === state.user.channel_name;
  const isSubscribed = (state.user.subscribed_channels || []).includes(decoded);
  const totalViews = videos.reduce((sum, video) => sum + Number(video.views || 0), 0);

  return `
    <div class="max-w-[1800px] mx-auto p-4 md:p-8">
      <div class="rounded-3xl border border-border bg-card p-6 md:p-8">
        <div class="flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div class="flex items-center gap-4">
            <div class="h-20 w-20 rounded-full bg-primary/20 flex items-center justify-center text-2xl font-bold text-primary">
              ${escapeHtml((decoded || "C").charAt(0).toUpperCase())}
            </div>
            <div>
              <h1 class="text-3xl font-bold">${escapeHtml(decoded)}</h1>
              <p class="text-muted-foreground mt-2">${videos.length} videos • ${formatCount(totalViews)} total views</p>
            </div>
          </div>
          <div class="flex gap-3">
            ${isOwnChannel ? `<button class="${primaryButtonClass()}" data-route="/upload">${iconUpload("h-4 w-4 mr-2")}Upload</button>` : ""}
            ${!isOwnChannel ? `<button class="${secondaryButtonClass()}" data-action="subscribe-channel" data-channel-name="${escapeAttr(decoded)}">${iconUsers("h-4 w-4 mr-2")} ${isSubscribed ? "Unsubscribe" : "Subscribe"}</button>` : ""}
          </div>
        </div>
      </div>
      <div class="mt-8">
        ${renderVideoGrid(videos, "This channel has no videos yet.")}
      </div>
    </div>
  `;
}

function renderAdminPage() {
  if (state.user.role !== "admin") {
    return renderEmptyState("Admin access required", "This panel is only available to admins.");
  }

  const mytubeStock = state.stocks.find((stock) => (stock.symbol || "").toLowerCase() === "mytube.co");
  const reported = state.videos.filter((video) => Number(video.report_count || 0) > 0).sort((a, b) => (b.report_count || 0) - (a.report_count || 0));

  return `
    <div class="max-w-[1800px] mx-auto p-4 md:p-8">
      <div class="flex items-center justify-between gap-4 mb-8">
        <div>
          <h1 class="text-3xl font-bold">Admin Panel</h1>
          <p class="text-muted-foreground mt-2">Review reports and remove inappropriate videos from the platform.</p>
        </div>
        <button class="${secondaryButtonClass()}" data-action="refresh-data">${iconRefresh("h-4 w-4 mr-2")}Refresh</button>
      </div>

      <div class="grid md:grid-cols-3 gap-4 mb-8">
        ${statCard("Total Videos", String(state.videos.length))}
        ${statCard("Reported Videos", String(reported.length))}
        ${statCard("Total Reports", String(reported.reduce((sum, video) => sum + Number(video.report_count || 0), 0)))}
      </div>

      <section class="rounded-3xl border border-border bg-card p-6 mb-8">
        <div class="flex items-center justify-between gap-3">
          <div>
            <h2 class="text-xl font-semibold">MyTube Stock</h2>
            <p class="text-sm text-muted-foreground">Adjust the MyTube stock price, movement, and auto trend behavior that shows up on the stock page.</p>
          </div>
          <span class="text-xs text-muted-foreground">Live price</span>
        </div>
          <form data-mytube-stock-form class="mt-6 grid gap-4 md:grid-cols-5">
            <label class="space-y-1 text-sm text-muted-foreground">
              Price
              <input class="${inputClass()}" name="price" type="number" step="0.01" value="${escapeAttr(mytubeStock?.price || 0)}" />
            </label>
            <label class="space-y-1 text-sm text-muted-foreground">
              Change
              <input class="${inputClass()}" name="change" type="number" step="0.01" value="${escapeAttr(mytubeStock?.change || 0)}" />
            </label>
            <label class="space-y-1 text-sm text-muted-foreground">
              Change %
              <input class="${inputClass()}" name="change_percent" type="number" step="0.01" value="${escapeAttr(mytubeStock?.changePercent || 0)}" />
            </label>
            <label class="space-y-1 text-sm text-muted-foreground">
              Trend
              <select class="${inputClass()}" name="trend_mode">
                ${[
                  ["stable", "Stable"],
                  ["slow_growth", "Grow Slowly"],
                  ["fast_growth", "Grow Fast"],
                  ["slow_decline", "Deplete Slowly"],
                  ["plummet", "Plummet"],
                ].map(([value, label]) => `<option value="${value}" ${(mytubeStock?.trendMode || "stable") === value ? "selected" : ""}>${label}</option>`).join("")}
              </select>
            </label>
          <button class="${primaryButtonClass()}" type="submit">Update MyTube Stock</button>
        </form>
      </section>

      <section class="rounded-3xl border border-border bg-card p-6">
        <h2 class="text-xl font-semibold mb-4">Reported Videos</h2>
        ${
          reported.length
            ? `<div class="space-y-4">${reported.map((video) => renderAdminVideoRow(video)).join("")}</div>`
            : renderMiniEmpty("No inappropriate videos have been reported.")
        }
      </section>

      <section class="rounded-3xl border border-border bg-card p-6 mt-8">
        <h2 class="text-xl font-semibold mb-4">All Videos</h2>
        ${
          state.videos.length
            ? `<div class="space-y-3">${state.videos.map((video) => renderAdminVideoRow(video)).join("")}</div>`
            : renderMiniEmpty("No videos have been uploaded yet.")
        }
      </section>
    </div>
  `;
}

function renderVideoGrid(videos, emptyText) {
  if (!videos.length) {
    return renderEmptyState("Nothing here yet", emptyText);
  }

  return `
    <div class="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
      ${videos.map((video) => renderVideoCard(video)).join("")}
    </div>
  `;
}

function renderVideoCard(video) {
  const isLiked = (state.user.liked_video_ids || []).includes(video.id);
  const isSubscribed = (state.user.subscribed_channels || []).includes(video.channel_name);
  const isOwnChannel = state.user.channel_name === video.channel_name;

  return `
    <article class="group rounded-3xl border border-border bg-card overflow-hidden">
      <button class="block w-full" data-route="/watch/${video.id}">
        <div class="aspect-video overflow-hidden bg-secondary">
          ${
            video.current_frame_url
              ? `<img class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" src="${escapeAttr(video.current_frame_url)}" alt="${escapeAttr(video.title)}" />`
              : video.thumbnail_url
              ? `<img class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" src="${escapeAttr(video.thumbnail_url)}" alt="${escapeAttr(video.title)}" />`
              : `<div class="h-full w-full flex items-center justify-center">${iconVideo("h-12 w-12 text-muted-foreground")}</div>`
          }
        </div>
      </button>
      <div class="p-4">
        <div class="flex gap-3">
          <button class="h-10 w-10 rounded-full bg-primary/20 flex items-center justify-center text-sm font-semibold text-primary shrink-0" data-route="/channel/${encodeURIComponent(video.channel_name)}">
            ${escapeHtml((video.channel_name || "C").charAt(0).toUpperCase())}
          </button>
          <div class="min-w-0 flex-1">
            <button class="text-left w-full" data-route="/watch/${video.id}">
              <h3 class="font-medium line-clamp-2">${escapeHtml(video.title)}</h3>
            </button>
            <button class="text-sm text-muted-foreground mt-1 hover:text-foreground" data-route="/channel/${encodeURIComponent(video.channel_name)}">
              ${escapeHtml(video.channel_name)}
            </button>
            <p class="text-xs text-muted-foreground mt-1">
              ${formatCount(video.views)} views • ${formatCount(video.likes)} likes
              ${video.is_live ? ` • LIVE • ${formatCount(state.liveViewerCounts[video.id] || 0)} watching` : ""}
            </p>
          </div>
        </div>
        <div class="mt-4 flex flex-wrap gap-2">
          <button class="${secondaryButtonClass("text-xs px-3 py-2 h-auto")}" data-action="like-video" data-video-id="${video.id}">
            ${iconHeart("h-3.5 w-3.5 mr-1.5")} ${isLiked ? "Unlike" : "Like"}
          </button>
          ${!isOwnChannel ? `<button class="${secondaryButtonClass("text-xs px-3 py-2 h-auto")}" data-action="subscribe-channel" data-channel-name="${escapeAttr(video.channel_name)}">
            ${iconUsers("h-3.5 w-3.5 mr-1.5")} ${isSubscribed ? "Following" : "Follow"}
          </button>` : ""}
          <button class="${secondaryButtonClass("text-xs px-3 py-2 h-auto")}" data-action="report-video" data-video-id="${video.id}">
            ${iconFlag("h-3.5 w-3.5 mr-1.5")} Report
          </button>
          ${(state.user.id === video.owner_id)
            ? `<button class="${secondaryButtonClass("text-xs px-3 py-2 h-auto")}" data-action="delete-video" data-video-id="${video.id}">${iconTrash("h-3.5 w-3.5 mr-1.5")} Delete</button>`
            : ""}
        </div>
      </div>
    </article>
  `;
}

function renderCompactVideoCard(video) {
  return `
    <button class="w-full rounded-2xl border border-border bg-card p-3 text-left hover:bg-accent/30" data-route="/watch/${video.id}">
      <div class="flex gap-3">
        <div class="h-20 w-32 rounded-xl overflow-hidden bg-secondary shrink-0">
          ${
            video.current_frame_url
              ? `<img class="h-full w-full object-cover" src="${escapeAttr(video.current_frame_url)}" alt="${escapeAttr(video.title)}" />`
              : video.thumbnail_url
              ? `<img class="h-full w-full object-cover" src="${escapeAttr(video.thumbnail_url)}" alt="${escapeAttr(video.title)}" />`
              : `<div class="h-full w-full flex items-center justify-center">${iconVideo("h-8 w-8 text-muted-foreground")}</div>`
          }
        </div>
        <div class="min-w-0">
          <h3 class="font-medium line-clamp-2">${escapeHtml(video.title)}</h3>
          <p class="text-sm text-muted-foreground mt-1">${escapeHtml(video.channel_name)}</p>
          <p class="text-xs text-muted-foreground mt-1">${formatCount(video.views)} views</p>
        </div>
      </div>
    </button>
  `;
}

function renderAdminVideoRow(video) {
  const reasons = (video.reports || []).map((report) => report.reason).filter(Boolean);
  return `
    <div class="rounded-2xl border border-border bg-background/40 p-4">
      <div class="flex flex-col lg:flex-row lg:items-center gap-4 justify-between">
        <div class="min-w-0">
          <div class="flex items-center gap-3 flex-wrap">
            <button class="font-semibold hover:text-primary" data-route="/watch/${video.id}">${escapeHtml(video.title)}</button>
            <span class="rounded-full bg-secondary px-3 py-1 text-xs text-muted-foreground">${escapeHtml(video.channel_name)}</span>
            <span class="rounded-full bg-red-500/15 px-3 py-1 text-xs text-red-300">${video.report_count || 0} reports</span>
          </div>
          <p class="text-sm text-muted-foreground mt-2">${escapeHtml(video.description || "No description provided.")}</p>
          ${reasons.length ? `<p class="text-xs text-muted-foreground mt-2">Reasons: ${escapeHtml(reasons.join(", "))}</p>` : ""}
        </div>
        <div class="flex gap-2 shrink-0">
          <button class="${secondaryButtonClass()}" data-route="/watch/${video.id}">${iconVideo("h-4 w-4 mr-2")}Open</button>
          <button class="${secondaryButtonClass()}" data-action="delete-video" data-video-id="${video.id}">${iconTrash("h-4 w-4 mr-2")}Remove</button>
        </div>
      </div>
    </div>
  `;
}

function renderAuthLayout({ title, subtitle, form }) {
  return `
    <div class="min-h-screen bg-background text-foreground">
      <div class="fixed inset-0 pointer-events-none">
        <div class="absolute -top-12 -left-12 h-72 w-72 rounded-full bg-blue-500/10 blur-3xl dark:bg-primary/10"></div>
        <div class="absolute -bottom-12 -right-12 h-72 w-72 rounded-full bg-slate-500/10 blur-3xl dark:bg-red-500/10"></div>
      </div>
      <div class="relative min-h-screen flex items-center justify-center p-4">
        <div class="w-full max-w-6xl grid md:grid-cols-2 rounded-3xl overflow-hidden border border-border bg-card shadow-2xl">
          <div class="hidden md:flex flex-col justify-between p-10 border-r border-border bg-gradient-to-br from-slate-50 via-slate-100 to-blue-100 dark:from-zinc-950 dark:via-zinc-900 dark:to-red-950">
            <div>
              <div class="inline-flex items-center gap-2 rounded-full border border-border bg-background/60 px-3 py-1 text-xs text-muted-foreground">
                ${iconShield("h-4 w-4 text-primary")}
                Local Authentication
              </div>
              <h1 class="mt-6 text-4xl font-bold text-slate-900 dark:text-white">Welcome to Northstar Math Academy!</h1>
              <p class="mt-4 text-base text-muted-foreground max-w-md">
                Create an account or sign in to start uploading and watching videos on your own private MyTube instance. Your data is stored locally and never shared with any third parties or teachers 😏😏😏.
              </p>
            </div>
            <div class="space-y-4">
              ${featureRow("Best place to watch videos in school", "Since MyTube runs entirely on your local network, you can access it even if securly blocks other popular video platforms.")}
              ${featureRow("Upload your own videos", "Share videos with your friends or classmates by uploading them to your MyTube Channel.")}
              ${featureRow("Manage your accounts", "Create multiple user accounts for different people using the same MyTube instance, or just to have a separate account for school and personal use.")}
            </div>
          </div>
          <div class="relative p-6 md:p-10">
            <div class="absolute right-4 top-4">
              ${renderThemeToggleButton()}
            </div>
            <div class="max-w-md mx-auto">
              <div class="flex items-center gap-3 mb-8">
                <div class="bg-primary rounded-xl p-2">${iconVideo("h-6 w-6 text-primary-foreground")}</div>
                <div>
                  <h2 class="text-2xl font-bold">${escapeHtml(title)}</h2>
                  <p class="text-sm text-muted-foreground">${escapeHtml(subtitle)}</p>
                </div>
              </div>
              ${form}
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderLoadingState() {
  return `
    <div class="fixed inset-0 flex items-center justify-center">
      <div class="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin"></div>
    </div>
  `;
}

function renderEmptyState(title, text) {
  return `
    <div class="rounded-3xl border border-border bg-card p-10 text-center">
      <div class="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-secondary">
        ${iconVideoOff("h-8 w-8 text-muted-foreground")}
      </div>
      <h2 class="mt-5 text-xl font-semibold">${escapeHtml(title)}</h2>
      <p class="mt-2 text-sm text-muted-foreground max-w-xl mx-auto">${escapeHtml(text)}</p>
    </div>
  `;
}

function renderMiniEmpty(text) {
  return `<div class="rounded-2xl border border-border bg-background/40 p-5 text-sm text-muted-foreground">${escapeHtml(text)}</div>`;
}

function renderFlashNotice() {
  if (!state.notice && !state.error) return "";
  const message = state.error || state.notice;
  const classes = state.error
    ? "mx-4 md:mx-6 mt-4 rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200"
    : "mx-4 md:mx-6 mt-4 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200";
  const output = `<div class="${classes}">${escapeHtml(message)}</div>`;
  state.notice = "";
  state.error = "";
  return output;
}

function renderMessage() {
  if (!state.error) return "";
  return `<div class="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">${escapeHtml(state.error)}</div>`;
}

function renderThemeToggleButton() {
  const theme = getTheme();
  const isDark = theme === "dark";
  const label = isDark ? "Light mode" : "Dark mode";
  const icon = isDark ? iconSun("h-4 w-4") : iconMoon("h-4 w-4");
  return `
    <button
      class="${secondaryButtonClass("gap-2 whitespace-nowrap")}"
      data-action="toggle-theme"
      type="button"
      aria-label="${label}"
      title="${label}"
    >
      ${icon}
      <span class="hidden sm:inline">${label}</span>
    </button>
  `;
}

function renderMathDiagram() {
  const darkMode = getTheme() === "dark";
  const borderClass = darkMode ? "border-slate-700" : "border-slate-200";
  const surfaceClass = darkMode ? "bg-slate-800/80" : "bg-slate-50";
  const headingClass = darkMode ? "text-white" : "text-slate-900";
  const mutedTextClass = darkMode ? "text-slate-300" : "text-slate-600";

  return `
    <div class="rounded-[1.75rem] border ${borderClass} ${surfaceClass} p-5">
      <div class="flex items-center justify-between">
        <p class="text-sm font-semibold ${headingClass}">Coordinate sketch</p>
        <span class="rounded-full ${darkMode ? "bg-slate-700 text-slate-300" : "bg-slate-200 text-slate-600"} px-3 py-1 text-xs">Diagram</span>
      </div>
      <svg viewBox="0 0 360 220" class="mt-4 h-auto w-full overflow-visible" aria-label="Math diagram">
        <rect x="0" y="0" width="360" height="220" rx="24" fill="${darkMode ? "rgba(15,23,42,0.82)" : "rgba(255,255,255,0.72)"}"></rect>
        <g stroke="${darkMode ? "rgba(100,116,139,0.45)" : "rgba(148,163,184,0.45)"}" stroke-width="1">
          ${Array.from({ length: 9 }, (_, index) => 30 + index * 30).map((value) => `
            <line x1="${value}" y1="24" x2="${value}" y2="196"></line>
            <line x1="24" y1="${value}" x2="336" y2="${value}"></line>
          `).join("")}
        </g>
        <line x1="32" y1="184" x2="328" y2="184" stroke="${darkMode ? "rgba(96,165,250,0.8)" : "rgba(37,99,235,0.8)"}" stroke-width="2"></line>
        <line x1="56" y1="32" x2="56" y2="188" stroke="${darkMode ? "rgba(96,165,250,0.8)" : "rgba(37,99,235,0.8)"}" stroke-width="2"></line>
        <path d="M56 184 C110 184, 128 138, 168 132 S234 92, 300 58" fill="none" stroke="${darkMode ? "rgba(96,165,250,0.95)" : "rgba(37,99,235,0.95)"}" stroke-width="4" stroke-linecap="round"></path>
        <circle cx="120" cy="146" r="7" fill="${darkMode ? "rgba(96,165,250,0.95)" : "rgba(59,130,246,0.95)"}"></circle>
        <circle cx="184" cy="124" r="7" fill="${darkMode ? "rgba(56,189,248,0.95)" : "rgba(14,165,233,0.95)"}"></circle>
        <circle cx="244" cy="86" r="7" fill="${darkMode ? "rgba(96,165,250,0.95)" : "rgba(37,99,235,0.95)"}"></circle>
        <text x="260" y="46" fill="${darkMode ? "rgba(148,163,184,0.95)" : "rgba(71,85,105,0.9)"}" font-size="16" font-family="Inter, sans-serif">y = mx + b</text>
      </svg>
    </div>
  `;
}

function featureRow(title, text) {
  return `
    <div class="flex items-start gap-3 rounded-2xl border border-border bg-background/40 p-4">
      <div class="mt-0.5 rounded-full bg-primary/20 p-1">${iconCheck("h-4 w-4 text-primary")}</div>
      <div>
        <p class="font-medium">${escapeHtml(title)}</p>
        <p class="text-sm text-muted-foreground mt-1">${escapeHtml(text)}</p>
      </div>
    </div>
  `;
}

function renderStockCard(stock) {
  const positive = Number(stock.change || 0) >= 0;
  const sourceLabel = stock.symbol === "mytube.co"
    ? formatTrendMode(stock.trendMode || "stable")
    : (stock.marketState || "REGULAR");
  const sparkline = state.stockHistoryBySymbol[stock.symbol]?.day || [];
  return `
    <button class="rounded-2xl border border-border bg-card p-5 text-left w-full ${state.selectedStockSymbol === stock.symbol ? "ring-2 ring-primary" : ""}" data-action="select-stock" data-symbol="${escapeAttr(stock.symbol)}" type="button">
      <div class="flex items-start justify-between gap-3">
        <div>
          <p class="text-xs text-muted-foreground uppercase tracking-wider">${escapeHtml(stock.symbol)}</p>
          <h3 class="text-lg font-semibold mt-1">${escapeHtml(stock.shortName || stock.symbol)}</h3>
        </div>
        <div class="rounded-full px-3 py-1 text-xs ${positive ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"}">
          ${positive ? "+" : ""}${Number(stock.changePercent || 0).toFixed(2)}%
        </div>
      </div>
      <p class="mt-5 text-3xl font-bold">$${Number(stock.price || 0).toFixed(2)}</p>
      <p class="mt-2 text-sm ${positive ? "text-emerald-300" : "text-red-300"}">
        ${positive ? "+" : ""}${Number(stock.change || 0).toFixed(2)} today
      </p>
      <p class="mt-2 text-xs text-muted-foreground">${escapeHtml(sourceLabel)}</p>
      <div class="mt-4">
        ${renderMiniStockChart(sparkline, positive)}
      </div>
    </button>
  `;
}

function formatTrendMode(mode) {
  switch (String(mode || "stable")) {
    case "fast_growth":
      return "Fast Growth";
    case "slow_growth":
      return "Slow Growth";
    case "plummet":
      return "Plummet";
    case "slow_decline":
      return "Slow Decline";
    default:
      return "Stable";
  }
}

function renderStockChart(stock, series) {
  if (!stock || !series.length) {
    return `<div class="rounded-2xl border border-border bg-background/40 p-8 text-muted-foreground">Chart data is loading.</div>`;
  }
  const positive = Number(stock.change || 0) >= 0;
  const stroke = positive ? "#34d399" : "#f87171";
  const area = positive ? "rgba(52, 211, 153, 0.18)" : "rgba(248, 113, 113, 0.18)";
  const points = buildChartPoints(series, 760, 260);
  const labels = formatStockLabels(series, state.stockChartRange);
  const low = Math.min(...series.map((point) => point.value));
  const high = Math.max(...series.map((point) => point.value));
  return `
    <div class="rounded-3xl border border-border bg-background/40 p-4 md:p-5">
      <div class="grid md:grid-cols-[minmax(0,1fr)_220px] gap-5 items-start">
        <div>
          <svg viewBox="0 0 760 260" class="w-full h-auto overflow-visible" role="img" aria-label="Stock chart">
            <defs>
              <linearGradient id="stock-fill-${escapeAttr(stock.symbol)}" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stop-color="${area}" />
                <stop offset="100%" stop-color="rgba(255,255,255,0)" />
              </linearGradient>
            </defs>
            <path d="${points.areaPath}" fill="url(#stock-fill-${escapeAttr(stock.symbol)})"></path>
            <path d="${points.linePath}" fill="none" stroke="${stroke}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"></path>
            ${points.markers.map((marker) => `<circle cx="${marker.x}" cy="${marker.y}" r="4" fill="${stroke}"></circle>`).join("")}
          </svg>
          <div class="mt-2 flex items-center justify-between text-xs text-muted-foreground">
            <span>${escapeHtml(labels.start)}</span>
            <span>${escapeHtml(labels.middle)}</span>
            <span>${escapeHtml(labels.end)}</span>
          </div>
        </div>
        <div class="grid gap-3">
          ${statCard("Current", `$${Number(stock.price || 0).toFixed(2)}`)}
          ${statCard("Range High", `$${high.toFixed(2)}`)}
          ${statCard("Range Low", `$${low.toFixed(2)}`)}
        </div>
      </div>
    </div>
  `;
}

function renderMiniStockChart(series, positive) {
  if (!series.length) {
    return `<div class="h-16 rounded-xl bg-background/40"></div>`;
  }
  const points = buildChartPoints(series, 240, 64);
  return `
    <svg viewBox="0 0 240 64" class="w-full h-16">
      <path d="${points.linePath}" fill="none" stroke="${positive ? "#34d399" : "#f87171"}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path>
    </svg>
  `;
}

function buildStockHistoryMap(stocks) {
  return Object.fromEntries((stocks || []).map((stock) => [
    stock.symbol,
    {
      day: buildSyntheticStockSeries(stock, "day"),
      week: buildSyntheticStockSeries(stock, "week"),
      month: buildSyntheticStockSeries(stock, "month"),
      year: buildSyntheticStockSeries(stock, "year"),
    },
  ]));
}

function buildSyntheticStockSeries(stock, range) {
  const config = getStockRangeConfig(range);
  const seed = hashString(`${stock.symbol}:${range}`);
  const price = Math.max(0.01, Number(stock.price || 0));
  const priorClose = Math.max(0.01, price - Number(stock.change || 0));
  const now = Date.now();
  const values = [];

  for (let index = 0; index < config.points; index++) {
    const progress = index / Math.max(1, config.points - 1);
    const wave = Math.sin(progress * Math.PI * (2 + (seed % 3))) * config.volatility * price;
    const jitter = (((seed + index * 17) % 100) / 100 - 0.5) * config.volatility * price * 0.55;
    const drift = (price - priorClose) * progress;
    const eased = Math.sin(progress * Math.PI) * wave;
    const value = Math.max(0.01, priorClose + drift + eased + jitter);
    values.push({
      value: Number(value.toFixed(2)),
      time: now - (config.points - 1 - index) * config.stepMs,
    });
  }

  values[values.length - 1] = { value: Number(price.toFixed(2)), time: now };
  return values;
}

function getStockRangeConfig(range) {
  switch (range) {
    case "week":
      return { points: 7, stepMs: 1000 * 60 * 60 * 24, volatility: 0.012 };
    case "month":
      return { points: 30, stepMs: 1000 * 60 * 60 * 24, volatility: 0.02 };
    case "year":
      return { points: 12, stepMs: 1000 * 60 * 60 * 24 * 30, volatility: 0.06 };
    default:
      return { points: 24, stepMs: 1000 * 60 * 60, volatility: 0.008 };
  }
}

function buildChartPoints(series, width, height) {
  const padding = 10;
  const values = series.map((point) => Number(point.value || 0));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(0.01, max - min);
  const coords = series.map((point, index) => {
    const x = padding + (index / Math.max(1, series.length - 1)) * (width - padding * 2);
    const y = height - padding - ((Number(point.value || 0) - min) / span) * (height - padding * 2);
    return { x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) };
  });
  const linePath = coords.map((coord, index) => `${index === 0 ? "M" : "L"} ${coord.x} ${coord.y}`).join(" ");
  const areaPath = `${linePath} L ${coords[coords.length - 1].x} ${height - padding} L ${coords[0].x} ${height - padding} Z`;
  const markers = [coords[0], coords[Math.floor(coords.length / 2)], coords[coords.length - 1]];
  return { linePath, areaPath, markers };
}

function formatStockLabels(series, range) {
  const formatter = getStockLabelFormatter(range);
  return {
    start: formatter(series[0]?.time),
    middle: formatter(series[Math.floor(series.length / 2)]?.time),
    end: formatter(series[series.length - 1]?.time),
  };
}

function getStockLabelFormatter(range) {
  if (range === "day") {
    return (value) => new Date(value || Date.now()).toLocaleTimeString([], { hour: "numeric" });
  }
  if (range === "week" || range === "month") {
    return (value) => new Date(value || Date.now()).toLocaleDateString([], { month: "short", day: "numeric" });
  }
  return (value) => new Date(value || Date.now()).toLocaleDateString([], { month: "short", year: "2-digit" });
}

function hashString(value) {
  let hash = 0;
  const text = String(value || "");
  for (let index = 0; index < text.length; index++) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function statCard(label, value) {
  return `
    <div class="rounded-2xl border border-border bg-card p-5">
      <p class="text-sm text-muted-foreground">${escapeHtml(label)}</p>
      <p class="mt-2 text-3xl font-bold">${escapeHtml(value)}</p>
    </div>
  `;
}

function orderedVideosByIds(ids) {
  const map = new Map(state.videos.map((video) => [video.id, video]));
  return (ids || []).map((id) => map.get(id)).filter(Boolean);
}

function getSortedVideos(mode) {
  const videos = [...state.videos];
  if (mode === "trending") {
    return videos.sort((a, b) => {
      const scoreA = Number(a.views || 0) + Number(a.likes || 0) * 10;
      const scoreB = Number(b.views || 0) + Number(b.likes || 0) * 10;
      return scoreB - scoreA;
    });
  }
  return videos.sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
}

function formatCount(value) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(Number(value || 0));
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function inputClass(extra = "") {
  return `mt-1.5 flex h-10 w-full rounded-md border border-input bg-secondary px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring ${extra}`.trim();
}

function textareaClass() {
  return "mt-1.5 flex min-h-28 w-full rounded-md border border-input bg-secondary px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring";
}

function primaryButtonClass(extra = "") {
  return `inline-flex items-center justify-center rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90 ${extra}`.trim();
}

function secondaryButtonClass(extra = "") {
  return `inline-flex items-center justify-center rounded-md border border-border bg-secondary px-4 py-2.5 text-sm font-medium hover:bg-accent ${extra}`.trim();
}

function initializeTheme() {
  installThemeStyles();
  const savedTheme = readTheme();
  applyTheme(savedTheme || "light");
}

function toggleTheme() {
  applyTheme(getTheme() === "dark" ? "light" : "dark");
}

function applyTheme(theme) {
  const nextTheme = theme === "dark" ? "dark" : "light";
  if (nextTheme === "dark") {
    document.documentElement.classList.add("dark");
  } else {
    document.documentElement.classList.remove("dark");
  }
  try {
    localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
  } catch {}
}

function readTheme() {
  try {
    const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
    return savedTheme === "dark" ? "dark" : savedTheme === "light" ? "light" : "";
  } catch {
    return "";
  }
}

function getTheme() {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function installThemeStyles() {
  if (document.getElementById(THEME_VARS_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = THEME_VARS_STYLE_ID;
  style.textContent = `
    :root {
      --background: 0 0% 99%;
      --foreground: 222.2 84% 4.9%;
      --card: 0 0% 100%;
      --card-foreground: 222.2 84% 4.9%;
      --popover: 0 0% 100%;
      --popover-foreground: 222.2 84% 4.9%;
      --primary: 221.2 83.2% 53.3%;
      --primary-foreground: 210 40% 98%;
      --secondary: 214.3 31.8% 91.4%;
      --secondary-foreground: 222.2 47.4% 11.2%;
      --muted: 210 40% 96.1%;
      --muted-foreground: 215.4 16.3% 46.9%;
      --accent: 210 40% 96.1%;
      --accent-foreground: 222.2 47.4% 11.2%;
      --destructive: 0 84.2% 60.2%;
      --destructive-foreground: 210 40% 98%;
      --border: 214.3 31.8% 84%;
      --input: 214.3 31.8% 84%;
      --ring: 221.2 83.2% 53.3%;
      --chart-1: 221.2 83.2% 53.3%;
      --chart-2: 210 70% 55%;
      --chart-3: 140 60% 45%;
      --chart-4: 45 90% 55%;
      --chart-5: 280 70% 55%;
      --sidebar-background: 0 0% 98%;
      --sidebar-foreground: 222.2 47.4% 11.2%;
      --sidebar-primary: 221.2 83.2% 53.3%;
      --sidebar-primary-foreground: 210 40% 98%;
      --sidebar-accent: 210 40% 96.1%;
      --sidebar-accent-foreground: 222.2 47.4% 11.2%;
      --sidebar-border: 214.3 31.8% 84%;
      --sidebar-ring: 221.2 83.2% 53.3%;
    }

    .dark {
      --background: 0 0% 7%;
      --foreground: 0 0% 95%;
      --card: 0 0% 11%;
      --card-foreground: 0 0% 95%;
      --popover: 0 0% 11%;
      --popover-foreground: 0 0% 95%;
      --primary: 0 90% 55%;
      --primary-foreground: 0 0% 100%;
      --secondary: 0 0% 16%;
      --secondary-foreground: 0 0% 90%;
      --muted: 0 0% 16%;
      --muted-foreground: 0 0% 55%;
      --accent: 0 0% 20%;
      --accent-foreground: 0 0% 95%;
      --destructive: 0 62.8% 30.6%;
      --destructive-foreground: 0 0% 98%;
      --border: 0 0% 18%;
      --input: 0 0% 18%;
      --ring: 0 90% 55%;
      --chart-1: 0 90% 55%;
      --chart-2: 210 70% 55%;
      --chart-3: 140 60% 45%;
      --chart-4: 45 90% 55%;
      --chart-5: 280 70% 55%;
      --sidebar-background: 0 0% 9%;
      --sidebar-foreground: 0 0% 85%;
      --sidebar-primary: 0 90% 55%;
      --sidebar-primary-foreground: 0 0% 100%;
      --sidebar-accent: 0 0% 14%;
      --sidebar-accent-foreground: 0 0% 95%;
      --sidebar-border: 0 0% 16%;
      --sidebar-ring: 0 90% 55%;
    }
  `;
  document.head.appendChild(style);
}

function navIcon(label) {
  const classes = "h-5 w-5 shrink-0";
  switch (label) {
    case "Home":
      return iconHome(classes);
    case "Trending":
      return iconTrending(classes);
    case "Subscriptions":
      return iconUsers(classes);
    case "History":
      return iconHistory(classes);
    case "Liked Videos":
      return iconHeart(classes);
    case "Profile":
      return iconUser(classes);
    case "My Channel":
      return iconUser(classes);
    case "Upload":
      return iconUpload(classes);
    case "Go Live":
      return iconLive(classes);
    case "MyTube Music":
      return iconMusic(classes);
    case "MyTube Live":
      return iconBroadcast(classes);
    case "MyTube Stock":
      return iconStock(classes);
    case "MyTube Sports":
      return iconSports(classes);
    case "Admin Panel":
      return iconShield(classes);
    default:
      return iconVideo(classes);
  }
}

function iconMoon(classes) { return svgIcon(classes, '<path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />'); }
function iconSun(classes) { return svgIcon(classes, '<circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />'); }
function iconBook(classes) { return svgIcon(classes, '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 3H20v18H6.5A2.5 2.5 0 0 1 4 18.5v-13A2.5 2.5 0 0 1 6.5 3Z" />'); }

function renderLiveChatPanel(video) {
  const messages = state.liveChatMessagesByVideo[video.id] || [];
  const viewerCount = Number(state.liveViewerCounts[video.id] || 0);
  return `
    <section class="mt-6 rounded-3xl border border-border bg-card p-5 space-y-4">
      <div class="flex items-center justify-between">
        <h2 class="text-lg font-semibold">Live chat</h2>
        <span class="text-xs text-muted-foreground">${viewerCount} viewer${viewerCount === 1 ? "" : "s"} watching</span>
      </div>
      <div class="max-h-64 overflow-y-auto space-y-3">
        ${messages.length
          ? messages.map((message) => renderLiveChatMessage(message)).join("")
          : `<p class="text-sm text-muted-foreground">Chat is waiting for the first message...</p>`}
      </div>
      ${state.user
        ? `<form data-live-chat-form class="flex items-center gap-3" data-video-id="${video.id}">
            <input
              class="${inputClass("flex-1")}"
              name="message"
              placeholder="Say something..."
              autocomplete="off"
              value="${escapeAttr(state.chatDraft)}"
              data-live-chat-input
            />
            <button class="${primaryButtonClass()}" type="submit">Send</button>
          </form>`
        : `<p class="text-sm text-muted-foreground">Sign in to join the chat.</p>`}
    </section>
  `;
}

function renderLiveChatMessage(message) {
  const label = escapeHtml(message.channel_name || message.full_name || "User");
  const text = escapeHtml(message.message || "");
  const timeStamp = message.created_at ? new Date(message.created_at).toLocaleTimeString() : "";
  return `
    <div class="flex items-start gap-3 text-sm">
      <div class="flex flex-col gap-0.5">
        <span class="font-semibold text-primary">${label}</span>
        <span class="text-xs text-muted-foreground">${escapeHtml(timeStamp)}</span>
      </div>
      <p class="text-sm text-foreground">${text}</p>
    </div>
  `;
}

function renderCommentSection(video) {
  const comments = state.commentsByVideo[video.id] || [];
  return `
    <section class="mt-6 rounded-3xl border border-border bg-card p-5 space-y-4">
      <div class="flex items-center justify-between">
        <h2 class="text-lg font-semibold">Comments</h2>
        <span class="text-xs text-muted-foreground">${comments.length} comment${comments.length === 1 ? "" : "s"}</span>
      </div>
      ${state.user
        ? `<form data-comment-form class="space-y-3" data-video-id="${video.id}">
            <textarea
              class="${textareaClass()}"
              name="comment"
              placeholder="Share your thoughts..."
              data-comment-input
            >${escapeHtml(state.commentDraft)}</textarea>
            <button class="${primaryButtonClass()}" type="submit">Post comment</button>
          </form>`
        : `<p class="text-sm text-muted-foreground">Log in to leave a comment.</p>`}
      <div class="space-y-3">
        ${comments.length
          ? comments.map((comment) => renderCommentRow(comment, video.id)).join("")
          : `<p class="text-sm text-muted-foreground">No comments yet. Be the first to leave one.</p>`}
      </div>
    </section>
  `;
}

function renderCommentRow(comment, videoId) {
  const author = escapeHtml(comment.channel_name || comment.full_name || "User");
  const body = escapeHtml(comment.content || "");
  const timestamp = comment.created_at ? new Date(comment.created_at).toLocaleString() : "";
  const canDelete = state.user && (state.user.role === "admin" || state.user.id === comment.user_id);
  return `
    <div class="rounded-2xl border border-border/50 bg-background/60 p-4 text-sm text-foreground">
      <div class="flex justify-between gap-3">
        <div>
          <p class="font-semibold text-foreground">${author}</p>
          <p class="text-xs text-muted-foreground">${escapeHtml(timestamp)}</p>
        </div>
        ${canDelete ? `<button class="${secondaryButtonClass("text-xs")}" data-action="delete-comment" data-video-id="${videoId}" data-comment-id="${comment.id}">Delete</button>` : ""}
      </div>
      <p class="mt-3 text-sm text-muted-foreground whitespace-pre-wrap">${body}</p>
    </div>
  `;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function svgIcon(classes, pathMarkup) {
  return `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="${classes}">${pathMarkup}</svg>`;
}

function iconMenu(classes) { return svgIcon(classes, '<path d="M4 6h16M4 12h16M4 18h16" />'); }
function iconVideo(classes) { return svgIcon(classes, '<rect x="3" y="6" width="13" height="12" rx="2" /><path d="M16 10.5 21 7v10l-5-3.5" />'); }
function iconVideoOff(classes) { return svgIcon(classes, '<path d="m3 3 18 18" /><rect x="3" y="6" width="13" height="12" rx="2" /><path d="M16 10.5 21 7v10l-5-3.5" />'); }
function iconSearch(classes) { return svgIcon(classes, '<circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />'); }
function iconUpload(classes) { return svgIcon(classes, '<path d="M12 16V4" /><path d="m7 9 5-5 5 5" /><path d="M4 20h16" />'); }
function iconRefresh(classes) { return svgIcon(classes, '<path d="M20 11a8 8 0 1 0 2 5.3" /><path d="M20 4v7h-7" />'); }
function iconSpark(classes) { return svgIcon(classes, '<path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" />'); }
function iconShield(classes) { return svgIcon(classes, '<path d="M12 3 5 6v6c0 5 3.4 8.4 7 9 3.6-.6 7-4 7-9V6l-7-3Z" />'); }
function iconCheck(classes) { return svgIcon(classes, '<path d="m5 12 4 4L19 6" />'); }
function iconHome(classes) { return svgIcon(classes, '<path d="M3 11.5 12 4l9 7.5" /><path d="M5 10.5V20h14v-9.5" />'); }
function iconTrending(classes) { return svgIcon(classes, '<path d="m3 17 6-6 4 4 7-7" /><path d="M14 8h7v7" />'); }
function iconUsers(classes) { return svgIcon(classes, '<circle cx="9" cy="8" r="3" /><path d="M3 19c0-3.3 2.7-6 6-6" /><circle cx="17" cy="10" r="3" /><path d="M13 19c.5-2.8 2.9-5 5.8-5" />'); }
function iconHistory(classes) { return svgIcon(classes, '<path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /><path d="M12 7v5l3 2" />'); }
function iconHeart(classes) { return svgIcon(classes, '<path d="m12 20-1.2-1.1C5.4 14 2 10.9 2 7.1 2 4.4 4.2 2 6.9 2c1.6 0 3.1.8 4.1 2 1-1.2 2.5-2 4.1-2C17.8 2 20 4.4 20 7.1c0 3.8-3.4 6.9-8.8 11.8Z" />'); }
function iconUser(classes) { return svgIcon(classes, '<circle cx="12" cy="8" r="4" /><path d="M4 20c1.8-3.5 5-5 8-5s6.2 1.5 8 5" />'); }
function iconMusic(classes) { return svgIcon(classes, '<path d="M9 18V5l10-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="16" cy="16" r="3" />'); }
function iconLive(classes) { return svgIcon(classes, '<rect x="3" y="7" width="12" height="10" rx="2" /><path d="m16 10 5-3v10l-5-3" /><circle cx="8" cy="12" r="1.5" />'); }
function iconBroadcast(classes) { return svgIcon(classes, '<path d="M2 12h2m16 0h2M12 2v2m0 16v2" /><circle cx="12" cy="12" r="3" /><path d="M5.6 5.6A9 9 0 0 0 3 12a9 9 0 0 0 2.6 6.4M18.4 5.6A9 9 0 0 1 21 12a9 9 0 0 1-2.6 6.4" />'); }
function iconStock(classes) { return svgIcon(classes, '<path d="M4 18 10 12l4 4 6-8" /><path d="M14 8h6v6" />'); }
function iconSports(classes) { return svgIcon(classes, '<path d="M7 14a5 5 0 1 0 10 0 5 5 0 0 0-10 0Z" /><path d="M12 9V5" /><path d="M9.5 11.2 6.5 8.2" /><path d="M14.5 11.2 17.5 8.2" /><path d="M7.5 17.2 5 19.7" /><path d="M16.5 17.2 19 19.7" />'); }
function iconFlag(classes) { return svgIcon(classes, '<path d="M5 21V5" /><path d="M5 5c5-2 9 2 14 0v8c-5 2-9-2-14 0" />'); }
function iconTrash(classes) { return svgIcon(classes, '<path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M6 6l1 14h10l1-14" /><path d="M10 11v6M14 11v6" />'); }
