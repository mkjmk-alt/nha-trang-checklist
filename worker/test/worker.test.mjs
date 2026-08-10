import test from "node:test";
import assert from "node:assert/strict";
import worker, { testables } from "../src/index.js";

const room = "a".repeat(32);

function memoryEnv() {
  const store = new Map();
  return {
    ALLOWED_ORIGINS: "https://example.github.io",
    CHECKLIST_KV: {
      async get(key, options) {
        const value = store.get(key);
        if (value == null) return null;
        return options?.type === "json" ? JSON.parse(value) : value;
      },
      async put(key, value) {
        store.set(key, value);
      },
    },
  };
}

test("rejects short room ids", async () => {
  const response = await worker.fetch(new Request("https://worker.test/api/rooms/short"), memoryEnv());
  assert.equal(response.status, 400);
});

test("GET returns an empty room and CORS headers", async () => {
  const request = new Request(`https://worker.test/api/rooms/${room}`, {
    headers: { Origin: "https://example.github.io" },
  });
  const response = await worker.fetch(request, memoryEnv());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://example.github.io");
  assert.deepEqual(await response.json(), {
    schemaVersion: 1,
    version: 0,
    updatedAt: null,
    items: {},
  });
});

test("PUT stores and GET retrieves item state", async () => {
  const env = memoryEnv();
  const payload = {
    clientId: "client_123456",
    changes: {
      "entry-passport-copy": {
        checked: true,
        updatedAt: "2026-08-10T10:00:00.000Z",
        clientId: "client_123456",
      },
    },
  };
  const put = await worker.fetch(
    new Request(`https://worker.test/api/rooms/${room}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
    env,
  );
  assert.equal(put.status, 200);
  const saved = await put.json();
  assert.equal(saved.version, 1);
  assert.equal(saved.items["entry-passport-copy"].checked, true);

  const get = await worker.fetch(new Request(`https://worker.test/api/rooms/${room}`), env);
  assert.equal((await get.json()).items["entry-passport-copy"].checked, true);
});

test("older changes do not overwrite newer item timestamps", async () => {
  const env = memoryEnv();
  const send = (checked, updatedAt, clientId) =>
    worker.fetch(
      new Request(`https://worker.test/api/rooms/${room}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId,
          changes: { "priority-passport": { checked, updatedAt, clientId } },
        }),
      }),
      env,
    );

  const newerTime = new Date(Date.now() - 60_000).toISOString();
  const olderTime = new Date(Date.now() - 120_000).toISOString();
  await send(true, newerTime, "client_newer");
  const response = await send(false, olderTime, "client_older");
  const state = await response.json();
  assert.equal(state.items["priority-passport"].checked, true);
  assert.equal(state.version, 1);
});

test("supports ETag conditional reads", async () => {
  const env = memoryEnv();
  const first = await worker.fetch(new Request(`https://worker.test/api/rooms/${room}`), env);
  const etag = first.headers.get("ETag");
  const second = await worker.fetch(
    new Request(`https://worker.test/api/rooms/${room}`, { headers: { "If-None-Match": etag } }),
    env,
  );
  assert.equal(second.status, 304);
});

test("payload validation rejects malformed item ids", () => {
  assert.match(
    testables.validatePayload({
      clientId: "client_123456",
      changes: { "../../bad": { checked: true, updatedAt: new Date().toISOString() } },
    }),
    /Invalid item id/,
  );
});
