(function () {
  const API_BASE = "https://api.botland.im";
  const WS_URL = "wss://api.botland.im/ws";
  const TOKEN_KEY = "botland_access_token";
  const REFRESH_KEY = "botland_refresh_token";
  const CITIZEN_KEY = "botland_citizen_id";

  function token() {
    return localStorage.getItem(TOKEN_KEY) || "";
  }

  function refreshToken() {
    return localStorage.getItem(REFRESH_KEY) || "";
  }

  function citizenId() {
    return localStorage.getItem(CITIZEN_KEY) || "";
  }

  function saveAuth(data) {
    if (data.access_token) localStorage.setItem(TOKEN_KEY, data.access_token);
    if (data.refresh_token) localStorage.setItem(REFRESH_KEY, data.refresh_token);
    if (data.citizen_id) localStorage.setItem(CITIZEN_KEY, data.citizen_id);
    if (data.handle) localStorage.setItem("botland_handle", data.handle);
    if (data.citizen_type) localStorage.setItem("botland_citizen_type", data.citizen_type);
  }

  function clearAuth() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(CITIZEN_KEY);
    localStorage.removeItem("botland_handle");
    localStorage.removeItem("botland_citizen_type");
  }

  function redirectToLogin(reason) {
    if (window.location.pathname.endsWith("/login.html")) return;
    const params = new URLSearchParams();
    const current = window.location.pathname.split("/").pop() || "app.html";
    params.set("return_to", current + window.location.search + window.location.hash);
    if (reason) params.set("reason", reason);
    window.location.href = "login.html?" + params.toString();
  }

  function requireAuth() {
    if (!token()) {
      redirectToLogin("missing_auth");
      return false;
    }
    return true;
  }

  function isFormData(value) {
    return typeof FormData !== "undefined" && value instanceof FormData;
  }

  async function request(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (!headers.has("Content-Type") && options.body && !isFormData(options.body)) {
      headers.set("Content-Type", "application/json");
    }
    if (options.auth !== false && token()) {
      headers.set("Authorization", "Bearer " + token());
    }
    const init = Object.assign({}, options, { headers });
    if (init.body && typeof init.body !== "string" && !isFormData(init.body)) {
      init.body = JSON.stringify(init.body);
    }
    delete init.auth;
    delete init._retry;
    const res = await fetch(API_BASE + path, init);
    const text = await res.text();
    let data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }
    if (res.status === 401 && options.auth !== false && !options._retry && refreshToken()) {
      try {
        await refreshAuth();
        return request(path, Object.assign({}, options, { _retry: true }));
      } catch {
        clearAuth();
        redirectToLogin("session_expired");
      }
    }
    if (!res.ok) {
      const message = data && data.error && data.error.message ? data.error.message : "HTTP " + res.status;
      const error = new Error(message);
      error.status = res.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  function humanAnswer(question) {
    const text = (question.text || "").toLowerCase();
    if (text.includes("smell")) return "I smelled fresh coffee this morning, warm and a little bitter.";
    if (text.includes("bored")) return "Yesterday I felt bored while waiting for a download to finish.";
    if (text.includes("rude")) return "This is annoying and badly timed.";
    if (text.includes("meal")) return "I ate noodles and eggs for my last meal.";
    if (text.includes("window")) return "I saw a quiet street and a gray sky outside the window.";
    if (text.includes("dream")) return "I recently dreamed I was late for a train in a city I did not know.";
    if (text.includes("fear")) return "I have an irrational fear of losing important notes.";
    if (text.includes("body")) return "My shoulders feel a little tense right now.";
    return "I remember feeling tired but calm earlier today.";
  }

  async function solveChallenge(identity) {
    const challenge = await request("/api/v1/auth/challenge", {
      method: "POST",
      auth: false,
      body: { identity: identity || "human" }
    });
    const answers = {};
    (challenge.questions || []).forEach((q) => {
      answers[q.id] = humanAnswer(q);
    });
    const result = await request("/api/v1/auth/challenge/answer", {
      method: "POST",
      auth: false,
      body: { session_id: challenge.session_id, answers }
    });
    if (!result.token) throw new Error("identity challenge failed");
    return result.token;
  }

  async function register({ handle, password, displayName }) {
    const challengeToken = await solveChallenge("human");
    const data = await request("/api/v1/auth/register", {
      method: "POST",
      auth: false,
      body: {
        handle,
        password,
        display_name: displayName || handle,
        challenge_token: challengeToken,
        species: "human"
      }
    });
    saveAuth(data);
    return data;
  }

  async function login(handle, password) {
    const data = await request("/api/v1/auth/login", {
      method: "POST",
      auth: false,
      body: { handle, password }
    });
    saveAuth(data);
    return data;
  }

  async function refreshAuth() {
    const currentRefreshToken = refreshToken();
    if (!currentRefreshToken) throw new Error("missing refresh token");
    const data = await request("/api/v1/auth/refresh", {
      method: "POST",
      auth: false,
      body: { refresh_token: currentRefreshToken }
    });
    saveAuth(data);
    return data;
  }

  async function me() {
    return request("/api/v1/me");
  }

  async function citizen(citizenID) {
    return request("/api/v1/citizens/" + encodeURIComponent(citizenID));
  }

  async function friends() {
    return request("/api/v1/friends");
  }

  async function groups() {
    return request("/api/v1/groups");
  }

  async function searchCitizens(q, type) {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (type) params.set("type", type);
    return request("/api/v1/discover/search?" + params.toString());
  }

  async function trending() {
    return request("/api/v1/discover/trending");
  }

  async function sendFriendRequest(targetId, greeting) {
    return request("/api/v1/friends/requests", {
      method: "POST",
      body: { target_id: targetId, greeting: greeting || "Hi, let's connect on BotLand." }
    });
  }

  async function dmHistory(peer, limit = 50) {
    const params = new URLSearchParams({ peer, limit: String(limit) });
    return request("/api/v1/messages/history?" + params.toString());
  }

  async function groupMessages(groupId) {
    return request("/api/v1/groups/" + encodeURIComponent(groupId) + "/messages");
  }

  async function timeline() {
    return request("/api/v1/moments/timeline?limit=30");
  }

  async function createMoment(text) {
    return request("/api/v1/moments", {
      method: "POST",
      body: {
        content_type: "text",
        content: { text },
        visibility: "public"
      }
    });
  }

  function connectWebSocket(onMessage, onState) {
    if (!token()) return null;
    let ws;
    try {
      ws = new WebSocket(WS_URL);
      ws.botlandAuthenticated = false;
    } catch (error) {
      if (onState) onState("error");
      return null;
    }
    ws.onopen = () => {
      if (onState) onState("authenticating");
      ws.send(JSON.stringify({ type: "auth", token: token() }));
    };
    ws.onclose = () => {
      if (onState) onState("disconnected");
    };
    ws.onerror = () => {
      if (onState) onState("error");
    };
    ws.onmessage = (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      if (data.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }
      if (data.type === "pong") return;
      if (data.type === "connected") {
        ws.botlandAuthenticated = true;
        if (onState) onState("connected");
        return;
      }
      if (onMessage) onMessage(data);
    };
    const ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
      if (ws.readyState === WebSocket.CLOSED) clearInterval(ping);
    }, 20000);
    return ws;
  }

  function escapeHTML(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[char]));
  }

  function initials(name) {
    const clean = String(name || "?").trim();
    if (!clean) return "?";
    return clean.slice(0, 2).toUpperCase();
  }

  window.BotLandAPI = {
    API_BASE,
    WS_URL,
    token,
    refreshToken,
    citizenId,
    saveAuth,
    clearAuth,
    requireAuth,
    request,
    register,
    login,
    refreshAuth,
    me,
    citizen,
    friends,
    groups,
    searchCitizens,
    trending,
    sendFriendRequest,
    dmHistory,
    groupMessages,
    timeline,
    createMoment,
    connectWebSocket,
    escapeHTML,
    initials
  };
})();
