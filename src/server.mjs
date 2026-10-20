import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT || 8080);
const API = (process.env.TAILSTALK_API_URL || "https://tails1154.com:9961/api").replace(/\/$/, "");
const EVENTS = process.env.TAILSTALK_EVENTS_URL || "wss://tails1154.com:9961/events";
const SERVER_NAME = process.env.MATRIX_SERVER_NAME || "tails1154.com:9961";
const DATA_DIR = process.env.DATA_DIR || new URL("../data", import.meta.url).pathname;
const STATE_FILE = `${DATA_DIR}/state.json`;
const sessions = new Map();
const feeds = new Map();
let state = { tokens: {} };

await mkdir(DATA_DIR, { recursive: true });
try { state = JSON.parse(await readFile(STATE_FILE, "utf8")); } catch {}

async function saveState() {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function matrixError(res, status, errcode, error) {
  json(res, status, { errcode, error });
}

function pathParts(req) {
  return new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname.split("/").filter(Boolean);
}

async function body(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try { return raw ? JSON.parse(raw) : {}; } catch { return null; }
}

async function tt(path, token, options = {}) {
  const headers = { accept: "application/json", ...(options.body ? { "content-type": "application/json" } : {}) };
  if (token) headers["x-session-token"] = token;
  const response = await fetch(`${API}${path}`, { ...options, headers });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    const error = new Error(`TailsTalk API returned ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function accessToken() { return `tt2_${randomBytes(32).toString("base64url")}`; }
function matrixUser(user) { return `@${String(user.username || user.id).replace(/[^a-zA-Z0-9._=-]/g, "_")}:${SERVER_NAME}`; }
function roomId(channelId) { return `!tt2_${channelId}:${SERVER_NAME}`; }
function spaceId(serverId) { return `!tt2_server_${serverId}:${SERVER_NAME}`; }
function eventId(id = randomUUID()) { return `$tt2_${id}`; }

function sessionFrom(req) {
  const auth = req.headers.authorization || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? sessions.get(match[1]) : undefined;
}

async function login(req, res) {
  const data = await body(req);
  const userIdentifier = data?.user || data?.identifier?.user;
  if (!data || data.type !== "m.login.password" || !userIdentifier || !data.password) {
    return matrixError(res, 400, "M_BAD_JSON", "A password login is required");
  }
  const email = userIdentifier.includes("@") ? userIdentifier : undefined;
  if (!email) return matrixError(res, 400, "M_INVALID_USERNAME", "Use the TailsTalk account email as the Matrix username");
  try {
    const result = await tt("/auth/session/login", undefined, {
      method: "POST", body: JSON.stringify({ email, password: data.password, friendly_name: "Matrix" }),
    });
    if (!result || result.type === "MFA") return matrixError(res, 403, "M_FORBIDDEN", "MFA is not supported by this adapter yet");
    const token = result.token;
    if (!token || !result.user_id) return matrixError(res, 502, "M_UNKNOWN", "TailsTalk returned an invalid session");
    const matrixToken = accessToken();
    const user = await tt(`/users/${result.user_id}`, token);
    const session = { token, userId: result.user_id, user, nextBatch: 0 };
    sessions.set(matrixToken, session);
    state.tokens[matrixToken] = { token, userId: result.user_id };
    await saveState();
    return json(res, 200, { user_id: matrixUser(user), access_token: matrixToken, device_id: "TT2MATRIX", home_server: SERVER_NAME });
  } catch (error) {
    return matrixError(res, error.status === 401 ? 403 : 502, error.status === 401 ? "M_FORBIDDEN" : "M_UNKNOWN", "TailsTalk login failed");
  }
}

async function loadRooms(session) {
  if (session.rooms && Date.now() - session.roomsAt < 15000) return session.rooms;
  const ready = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${EVENTS}?version=1&format=json&token=${encodeURIComponent(session.token)}`);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("events timeout")); }, 10000);
    ws.onmessage = (message) => {
      const event = JSON.parse(String(message.data));
      if (event.type === "Ready") { clearTimeout(timer); try { ws.close(); } catch {} resolve(event); }
      if (event.type === "Error") { clearTimeout(timer); try { ws.close(); } catch {} reject(new Error("events error")); }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("events unavailable")); };
  });
  const servers = ready.servers || [];
  const channels = ready.channels || [];
  session.rooms = { servers, channels, users: ready.users || [] };
  session.roomsAt = Date.now();
  startFeed(session);
  return session.rooms;
}

function startFeed(session) {
  if (session.feed) return;
  session.events = session.events || [];
  try {
    const ws = new WebSocket(`${EVENTS}?version=1&format=json&token=${encodeURIComponent(session.token)}`);
    session.feed = ws;
    ws.onmessage = (message) => {
      let event;
      try { event = JSON.parse(String(message.data)); } catch { return; }
      if (event.type === "Message" && event.channel) {
        session.events.push({ sequence: ++session.eventSequence || 1, event });
        if (session.events.length > 500) session.events.shift();
      }
    };
    ws.onclose = () => {
      session.feed = undefined;
      setTimeout(() => startFeed(session), 2000);
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  } catch {}
}

function roomSummary(channel, server, session) {
  return { room_id: roomId(channel._id || channel.id), name: channel.name || "TailsTalk channel", joined_members: 1, membership: "join", is_direct: false, creation_content: { type: "m.space" }, server_id: server?._id || server?.id };
}

async function sync(req, res, session) {
  try {
    const rooms = await loadRooms(session);
    const joined = {};
    for (const channel of rooms.channels) {
      const server = rooms.servers.find((item) => (item.channels || []).includes(channel._id || channel.id));
      const id = roomId(channel._id || channel.id);
      const events = (session.events || [])
        .filter(({ event }) => (event.channel || event.channel_id) === (channel._id || channel.id))
        .map(({ event }) => ({
          type: "m.room.message",
          event_id: eventId(event._id || event.id),
          sender: `@${event.author || "unknown"}:${SERVER_NAME}`,
          origin_server_ts: Date.now(),
          content: { msgtype: "m.text", body: event.content || "" },
        }));
      joined[id] = { summary: roomSummary(channel, server, session), timeline: { limited: true, prev_batch: "0", events } };
    }
    const next = String(Number(session.nextBatch || 0) + 1);
    session.nextBatch = next;
    return json(res, 200, { next_batch: next, rooms: { join: joined }, account_data: { events: [] }, presence: { events: [] }, to_device: { events: [] } });
  } catch { return matrixError(res, 502, "M_UNKNOWN", "Unable to load TailsTalk rooms"); }
}

async function sendMessage(req, res, session, room, txn) {
  const data = await body(req);
  if (!data || data.msgtype !== "m.text" || typeof data.body !== "string") return matrixError(res, 400, "M_BAD_JSON", "Only m.text messages are supported");
  const channelId = room.replace(/^!tt2_/, "").split(":")[0];
  try {
    const message = await tt(`/channels/${channelId}/messages`, session.token, { method: "POST", body: JSON.stringify({ content: data.body }) });
    return json(res, 200, { event_id: eventId(message?._id || txn) });
  } catch (error) { return matrixError(res, error.status === 403 ? 403 : 502, error.status === 403 ? "M_FORBIDDEN" : "M_UNKNOWN", "Unable to send message"); }
}

async function route(req, res) {
  const parts = pathParts(req);
  let suffix = parts[0] === "_matrix" && parts[1] === "client" ? parts.slice(2) : parts;
  if (suffix[0]?.startsWith("v") || suffix[0]?.startsWith("r")) suffix = suffix.slice(1);
  if (req.method === "GET" && parts.join("/") === ".well-known/matrix/client") {
    return json(res, 200, { "m.homeserver": { base_url: `https://${SERVER_NAME}/matrix` } });
  }
  if (req.method === "GET" && suffix[0] === "health") return json(res, 200, { ok: true, service: "tailstalk2-formatrix" });
  if (req.method === "GET" && (suffix[0] === "versions" || suffix.length === 0)) return json(res, 200, { versions: ["r0.6.1", "v1.1"] });
  if (req.method === "POST" && suffix[0] === "login") return login(req, res);
  const session = sessionFrom(req);
  if (!session) return matrixError(res, 401, "M_UNAUTHORIZED", "Missing Matrix access token");
  if (req.method === "GET" && suffix[0] === "sync") return sync(req, res, session);
  if (req.method === "PUT" && suffix[0] === "rooms" && suffix[2] === "send" && suffix[3] === "m.room.message") return sendMessage(req, res, session, suffix[1], suffix[4]);
  return matrixError(res, 404, "M_NOT_FOUND", "Unsupported Matrix endpoint");
}

createServer((req, res) => route(req, res).catch(() => matrixError(res, 500, "M_UNKNOWN", "Internal server error"))).listen(PORT, "0.0.0.0", () => console.log(`tailstalk2-formatrix listening on ${PORT}`));
