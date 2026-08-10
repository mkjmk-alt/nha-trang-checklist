const ROOM_PATTERN = /^[A-Za-z0-9_-]{32,64}$/;
const ITEM_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CLIENT_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BODY_BYTES = 100_000;
const MAX_CHANGES = 200;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env.ALLOWED_ORIGINS || "*");

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      const url = new URL(request.url);
      const match = url.pathname.match(/^\/api\/rooms\/([^/]+)$/);
      if (!match) return json({ error: "Not found" }, 404, cors);

      let room;
      try {
        room = decodeURIComponent(match[1]);
      } catch {
        return json({ error: "Invalid room id encoding." }, 400, cors);
      }
      if (!ROOM_PATTERN.test(room)) {
        return json({ error: "Room id must be a 32–64 character URL-safe token." }, 400, cors);
      }

      if (request.method === "GET") return getRoom(request, env, room, cors);
      if (request.method === "PUT") return putRoom(request, env, room, cors);
      return json({ error: "Method not allowed" }, 405, { ...cors, Allow: "GET, PUT, OPTIONS" });
    } catch (error) {
      console.error("Unhandled room API error", error);
      return json({ error: "Internal server error." }, 500, cors);
    }
  },
};

async function getRoom(request, env, room, cors) {
  const state = await readState(env, room);
  const etag = makeEtag(state);
  if (request.headers.get("If-None-Match") === etag) {
    return new Response(null, { status: 304, headers: { ...cors, ETag: etag } });
  }
  return json(state, 200, { ...cors, ETag: etag, "Cache-Control": "no-store" });
}

async function putRoom(request, env, room, cors) {
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > MAX_BODY_BYTES) return json({ error: "Request body is too large." }, 413, cors);
  if (!request.headers.get("Content-Type")?.toLowerCase().includes("application/json")) {
    return json({ error: "Content-Type must be application/json." }, 415, cors);
  }

  let body;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
      return json({ error: "Request body is too large." }, 413, cors);
    }
    body = JSON.parse(text);
  } catch {
    return json({ error: "Invalid JSON." }, 400, cors);
  }

  const validationError = validatePayload(body);
  if (validationError) return json({ error: validationError }, 400, cors);

  const current = await readState(env, room);
  const now = Date.now();
  let changed = false;

  for (const [id, incoming] of Object.entries(body.changes)) {
    const normalized = normalizeEntry(incoming, body.clientId, now);
    if (compareEntries(normalized, current.items[id]) > 0) {
      current.items[id] = normalized;
      changed = true;
    }
  }

  if (changed) {
    current.version += 1;
    current.updatedAt = new Date(now).toISOString();
    try {
      await env.CHECKLIST_KV.put(roomKey(room), JSON.stringify(current));
    } catch (error) {
      const message = String(error?.message || error);
      const isRateLimit = /rate|too many|1 write per second/i.test(message);
      return json(
        { error: isRateLimit ? "Write rate exceeded. Retry shortly." : "Could not save room state." },
        isRateLimit ? 429 : 500,
        isRateLimit ? { ...cors, "Retry-After": "2" } : cors,
      );
    }
  }

  return json(current, 200, {
    ...cors,
    ETag: makeEtag(current),
    "Cache-Control": "no-store",
  });
}

async function readState(env, room) {
  const stored = await env.CHECKLIST_KV.get(roomKey(room), { type: "json" });
  if (!stored || typeof stored !== "object") return emptyState();

  const items = {};
  for (const [id, entry] of Object.entries(stored.items || {}).slice(0, MAX_CHANGES)) {
    if (!ITEM_PATTERN.test(id) || !isEntry(entry)) continue;
    items[id] = {
      checked: entry.checked,
      updatedAt: new Date(entry.updatedAt).toISOString(),
      clientId: CLIENT_PATTERN.test(entry.clientId || "") ? entry.clientId : "server",
    };
  }

  return {
    schemaVersion: 1,
    version: Number.isSafeInteger(stored.version) && stored.version >= 0 ? stored.version : 0,
    updatedAt: isDate(stored.updatedAt) ? new Date(stored.updatedAt).toISOString() : null,
    items,
  };
}

function validatePayload(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "Body must be an object.";
  if (!CLIENT_PATTERN.test(body.clientId || "")) return "Invalid clientId.";
  if (!body.changes || typeof body.changes !== "object" || Array.isArray(body.changes)) {
    return "changes must be an object.";
  }
  const changes = Object.entries(body.changes);
  if (!changes.length || changes.length > MAX_CHANGES) return `changes must contain 1–${MAX_CHANGES} items.`;
  for (const [id, entry] of changes) {
    if (!ITEM_PATTERN.test(id)) return `Invalid item id: ${id}`;
    if (!isEntry(entry)) return `Invalid change for item: ${id}`;
  }
  return "";
}

function isEntry(entry) {
  return (
    entry &&
    typeof entry === "object" &&
    typeof entry.checked === "boolean" &&
    isDate(entry.updatedAt) &&
    (!entry.clientId || CLIENT_PATTERN.test(entry.clientId))
  );
}

function isDate(value) {
  return typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value));
}

function normalizeEntry(entry, fallbackClientId, now) {
  const parsed = Date.parse(entry.updatedAt);
  const safeTime = Math.min(parsed, now + MAX_FUTURE_SKEW_MS);
  return {
    checked: entry.checked,
    updatedAt: new Date(safeTime).toISOString(),
    clientId: CLIENT_PATTERN.test(entry.clientId || "") ? entry.clientId : fallbackClientId,
  };
}

function compareEntries(a, b) {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const timeDifference = Date.parse(a.updatedAt) - Date.parse(b.updatedAt);
  if (timeDifference !== 0) return timeDifference;
  return String(a.clientId).localeCompare(String(b.clientId));
}

function emptyState() {
  return { schemaVersion: 1, version: 0, updatedAt: null, items: {} };
}

function roomKey(room) {
  return `room:${room}`;
}

function makeEtag(state) {
  return `W/\"${state.version}-${state.updatedAt || "empty"}\"`;
}

function corsHeaders(origin, setting) {
  const allowed = String(setting)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const allowOrigin = allowed.includes("*") ? "*" : allowed.includes(origin) ? origin : allowed[0] || "null";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, If-None-Match",
    "Access-Control-Expose-Headers": "ETag",
    "Access-Control-Max-Age": "86400",
    ...(allowOrigin !== "*" ? { Vary: "Origin" } : {}),
  };
}

function json(value, status, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

export const testables = {
  compareEntries,
  normalizeEntry,
  validatePayload,
  ROOM_PATTERN,
};
