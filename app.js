const root = document.getElementById("root");

const state = {
  user: null,
  videos: [],
  stocks: [],
  stocksUpdatedAt: "",
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
  pagePollTimer: null,
  stockPollTimer: null,
  viewerPC: null,
  viewerPoll: null,
  viewerVideoId: "",
  viewerPeerId: "",
  liveChatSource: null,
  liveChatVideoId: "",
  liveViewerPoller: null,
};

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
    ],
  },
];

state.route = parseRoute();

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

  if (action === "logout") {
    try {
      await api("/api/logout", { method: "POST" });
    } catch {}
    state.user = null;
    state.videos = [];
    state.notice = "You have been logged out.";
    state.route = parseRoute();
    setRoute("/login");
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

  if (!state.user && !isPublicRoute(state.route.name)) {
    setRoute("/login");
    return;
  }

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

  try {
    const [user, videosResponse] = await Promise.all([api("/api/me"), api("/api/videos")]);
    state.user = user;
    state.videos = videosResponse.videos || [];
    state.error = "";
  } catch (error) {
    state.user = null;
    state.videos = [];
    if (!isPublicRoute(state.route.name)) {
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
    if (isLive && !runtime.cameraStream) {
      throw new Error("Enable your camera before starting a live broadcast.");
    }

    const multipart = new FormData();
    multipart.set("title", String(formData.get("title") || "").trim());
    multipart.set("description", String(formData.get("description") || "").trim());
    multipart.set("category", String(formData.get("category") || "general"));
    multipart.set("tags", String(formData.get("tags") || ""));
    multipart.set("duration", String(formData.get("duration") || "0:00"));
    multipart.set("is_live", isLive ? "true" : "false");
    multipart.set("is_music", isMusic ? "true" : "false");
    const thumbnailFile = formData.get("thumbnail_file");
    const videoFile = formData.get("video_file");
    if (thumbnailFile && thumbnailFile.size) {
      multipart.set("thumbnail_file", thumbnailFile);
    }
    if (!isLive && videoFile && videoFile.size) {
      multipart.set("video_file", videoFile);
    }

    const payload = await api("/api/videos", {
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

    await refreshAppData();
    state.notice = isLive ? "Live stream created." : "Video uploaded.";
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
  if (Number.isNaN(price) || Number.isNaN(change) || Number.isNaN(changePercent)) {
    state.notice = "Invalid stock values.";
    render();
    return;
  }

  try {
    await api("/api/stocks/mytube", {
      method: "POST",
      body: { price, change, changePercent },
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

  runtime.cameraStream.getTracks().forEach((track) => {
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
      video: true,
      audio: true,
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

  if (watchingLiveVideo || state.route.name === "live") {
    if (!runtime.pagePollTimer) {
      runtime.pagePollTimer = window.setInterval(refreshAppData, 3000);
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
  for (const peerId of Object.keys(runtime.broadcastPeers)) {
    removeBroadcastPeer(peerId);
  }
}

async function refreshStocks() {
  try {
    const payload = await api("/api/stocks");
    state.stocks = payload.stocks || [];
    state.stocksUpdatedAt = payload.updated_at || "";
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
  if (!source || !runtime.cameraStream) return;

  const canvas = document.createElement("canvas");
  canvas.width = source.videoWidth || 1280;
  canvas.height = source.videoHeight || 720;
  const context = canvas.getContext("2d");
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  const frame = canvas.toDataURL("image/webp", 0.6);

  await api(`/api/videos/${encodeURIComponent(videoId)}/frame`, {
    method: "POST",
    body: { current_frame_url: frame },
  });
}

// ======================================================
//  WEBRTC VIEWER — connects to broadcaster
// ======================================================
async function startLiveViewer(videoId) {
  stopLiveViewer();

  const videoEl = document.getElementById("live-player");
  if (!videoEl) {
    return;
  }

  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });
  runtime.viewerPC = pc;
  runtime.viewerVideoId = videoId;
  runtime.viewerPeerId = cryptoRandomId();

  pc.ontrack = (event) => {
    videoEl.srcObject = event.streams[0];
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

  let answered = false;
  const pendingCandidates = [];

  const pollSignals = async () => {
    try {
      const { signals = [] } = await api(`/api/videos/${videoId}/signal?for=viewer&peer_id=${encodeURIComponent(runtime.viewerPeerId)}`);
      for (const signal of signals) {
        if (signal.type === "offer" && signal.offer && !pc.currentRemoteDescription && !answered) {
          await pc.setRemoteDescription(new RTCSessionDescription(signal.offer));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await api(`/api/videos/${videoId}/signal`, {
            method: "POST",
            body: { type: "answer", answer, source: "viewer", peer_id: runtime.viewerPeerId },
          });
          answered = true;
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
      console.error("Viewer signal poll error:", error);
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
  runtime.viewerVideoId = "";
  runtime.viewerPeerId = "";
  const videoEl = document.getElementById("live-player");
  if (videoEl) {
    videoEl.srcObject = null;
    videoEl.pause().catch(() => {});
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
    return;
  }
  void startLiveViewer(video.id).catch((error) => console.error("Live viewer failed:", error));
}

function cryptoRandomId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return `peer_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}


function render() {
  root.innerHTML = state.user ? renderShell() : renderPublicPage();
  syncLivePreview();
  syncBackgroundEffects();
  syncLiveViewer();
  syncLiveChatStream();
}

function renderPublicPage() {
  if (state.route.name === "signup") {
    return renderAuthLayout({
      title: "Create your MyTube account",
      subtitle: "Standalone auth is now built into this version.",
      form: `
        <form data-signup-form class="space-y-4">
          <div>
            <label class="text-sm font-medium">Full name</label>
            <input class="${inputClass()}" name="full_name" placeholder="Sebastian Jordan" required />
          </div>
          <div>
            <label class="text-sm font-medium">Channel name</label>
            <input class="${inputClass()}" name="channel_name" placeholder="sebastianjordan" />
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
      return renderFeedPage("MyTube Live", "Current and recent live streams.", state.videos.filter((video) => video.is_live));
    case "stock":
      return renderStockPage();
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
              ${showCreate ? `<button class="${primaryButtonClass()}" data-route="/upload">${iconUpload("h-4 w-4 mr-2")}Upload</button>` : ""}
              <button class="${secondaryButtonClass()}" data-action="refresh-data">${iconRefresh("h-4 w-4 mr-2")}Refresh</button>
            </div>
          </div>
        </div>
      </section>

      <div class="p-4 md:p-6 max-w-[1800px] mx-auto">
        ${renderVideoGrid(videos, `${title} is empty right now. Upload a video or create a live stream to populate this page.`)}
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

function renderWatchPage() {
  const video = state.videos.find((entry) => entry.id === state.route.params.id);
  if (!video) {
    return renderEmptyState("Video not found", "This video may have been removed.");
  }

  const related = state.videos.filter((entry) => entry.id !== video.id).slice(0, 6);
  const isLiked = (state.user.liked_video_ids || []).includes(video.id);
  const isSubscribed = (state.user.subscribed_channels || []).includes(video.channel_name);
  const isOwnChannel = state.user.channel_name === video.channel_name;

  return `
    <div class="p-4 md:p-6 max-w-[1800px] mx-auto">
      <div class="grid xl:grid-cols-[minmax(0,1fr)_360px] gap-8">
        <div>
          <div class="aspect-video rounded-3xl overflow-hidden border border-border bg-card">
  ${
    video.is_live
      ? `<video id="live-player" autoplay playsinline class="w-full h-full object-cover bg-black"></video>`
      : video.video_url
        ? `<video class="w-full h-full object-cover bg-black" src="${escapeAttr(video.video_url)}" controls playsinline preload="metadata"></video>`
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
                  ${["news", "gaming", "music", "tech", "education", "general", "stock"]
                    .map((category) => `<option value="${category}" ${category === "news" ? "selected" : ""}>${capitalize(category)}</option>`)
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
            <label class="text-sm font-medium">Video File</label>
            <input class="${inputClass()}" type="file" name="video_file" accept="video/*" required />
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
                .map((category) => `<option value="${category}" ${isLive && category === "news" ? "selected" : ""}>${capitalize(category)}</option>`)
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
        </div>
        ${renderMessage()}
        <button class="${primaryButtonClass()}" type="submit" ${state.uploadLoading ? "disabled" : ""}>
          ${state.uploadLoading ? "Saving..." : "Upload Video"}
        </button>
        <div class="rounded-2xl border border-border bg-background/60 p-4 text-sm text-muted-foreground">
          Want to stream your camera live instead?
          <button class="ml-1 text-primary hover:underline" type="button" data-route="/go-live">Open Go Live</button>
        </div>
      </form>
    </div>
  `;
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
            <p class="text-sm text-muted-foreground">Adjust the MyTube stock price and movement that shows up on the stock page.</p>
          </div>
          <span class="text-xs text-muted-foreground">Live price</span>
        </div>
          <form data-mytube-stock-form class="mt-6 grid gap-4 md:grid-cols-4">
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
        <div class="absolute -top-12 -left-12 h-72 w-72 rounded-full bg-primary/10 blur-3xl"></div>
        <div class="absolute -bottom-12 -right-12 h-72 w-72 rounded-full bg-red-500/10 blur-3xl"></div>
      </div>
      <div class="relative min-h-screen flex items-center justify-center p-4">
        <div class="w-full max-w-6xl grid md:grid-cols-2 rounded-3xl overflow-hidden border border-border bg-card shadow-2xl">
          <div class="hidden md:flex flex-col justify-between p-10 border-r border-border bg-gradient-to-br from-zinc-950 via-zinc-900 to-red-950">
            <div>
              <div class="inline-flex items-center gap-2 rounded-full border border-border bg-background/40 px-3 py-1 text-xs text-muted-foreground">
                ${iconShield("h-4 w-4 text-primary")}
                Local Authentication
              </div>
              <h1 class="mt-6 text-4xl font-bold">MyTube Standalone</h1>
              <p class="mt-4 text-base text-muted-foreground max-w-md">
                All the main pages now run against your own local backend instead of Base44.
              </p>
            </div>
            <div class="space-y-4">
              ${featureRow("Working pages", "Home, watch, search, uploads, live, channel views, likes, history, and subscriptions.")}
              ${featureRow("Admin moderation", "Admins can review reports and delete inappropriate videos.")}
              ${featureRow("Your accounts", "Your user account and admin account are both available from this screen.")}
            </div>
          </div>
          <div class="p-6 md:p-10">
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
  return `
    <div class="rounded-2xl border border-border bg-card p-5">
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
      <p class="mt-2 text-xs text-muted-foreground">${escapeHtml(stock.marketState || "REGULAR")}</p>
    </div>
  `;
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
    case "Admin Panel":
      return iconShield(classes);
    default:
      return iconVideo(classes);
  }
}

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
function iconFlag(classes) { return svgIcon(classes, '<path d="M5 21V5" /><path d="M5 5c5-2 9 2 14 0v8c-5 2-9-2-14 0" />'); }
function iconTrash(classes) { return svgIcon(classes, '<path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M6 6l1 14h10l1-14" /><path d="M10 11v6M14 11v6" />'); }
