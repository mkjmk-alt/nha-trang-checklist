(() => {
  "use strict";

  const categories = window.NHA_TRANG_CHECKLIST || [];
  const config = window.NHA_TRANG_CONFIG || {};
  const allItems = categories.flatMap((category) => category.items);
  const itemIds = new Set(allItems.map((item) => item.id));
  const query = new URLSearchParams(window.location.search);
  const roomFromUrl = query.get("room") || "";
  const validRoom = /^[A-Za-z0-9_-]{32,64}$/.test(roomFromUrl) ? roomFromUrl : "";
  const apiConfigured =
    typeof config.apiBaseUrl === "string" &&
    /^https:\/\//.test(config.apiBaseUrl) &&
    !config.apiBaseUrl.includes("YOUR-WORKER");
  const apiBaseUrl = apiConfigured ? config.apiBaseUrl.replace(/\/$/, "") : "";
  const pollSchedule = normalizePollSchedule(config.pollScheduleMs, [180000, 300000, 600000]);
  const clientId = getOrCreateClientId();

  let room = validRoom;
  let entries = loadEntries(room);
  let activeFilter = "all";
  let searchTerm = "";
  let pollTimer = null;
  let pollStep = 0;
  let pollingGeneration = 0;
  let adaptiveSyncActive = false;
  let nextPollAt = null;
  let relativeTimeTimer = null;
  let lastSyncedAt = null;
  let lastEtag = "";
  let isSyncing = false;
  let pendingChanges = {};
  let flushTimer = null;
  let lastWriteStartedAt = 0;
  let toastTimer = null;

  const elements = {
    checklist: document.querySelector("#checklist"),
    emptyState: document.querySelector("#emptyState"),
    progressText: document.querySelector("#progressText"),
    progressPercent: document.querySelector("#progressPercent"),
    progressFill: document.querySelector("#progressFill"),
    progressTrack: document.querySelector(".progress-track"),
    requiredRemaining: document.querySelector("#requiredRemaining"),
    completionMessage: document.querySelector("#completionMessage"),
    searchInput: document.querySelector("#searchInput"),
    shareButton: document.querySelector("#shareButton"),
    shareButtonText: document.querySelector("#shareButtonText"),
    syncButton: document.querySelector("#syncButton"),
    resetButton: document.querySelector("#resetButton"),
    syncStatus: document.querySelector("#syncStatus"),
    syncStatusText: document.querySelector("#syncStatusText"),
    lastSyncText: document.querySelector("#lastSyncText"),
    toast: document.querySelector("#toast"),
    allCount: document.querySelector("#allCount"),
    incompleteCount: document.querySelector("#incompleteCount"),
    requiredCount: document.querySelector("#requiredCount"),
    completedCount: document.querySelector("#completedCount"),
  };

  init();

  function init() {
    render();
    bindEvents();
    updateRoomControls();
    relativeTimeTimer = window.setInterval(updateLastSyncLabel, 30000);

    if (room && apiConfigured) {
      setSyncStatus("syncing", "처음 상태를 불러오는 중");
      syncNow({ force: true }).then((result) => {
        if (result === "changed" || result === "unchanged") enterManualMode();
      });
    } else if (room && !apiConfigured) {
      setSyncStatus("error", "Worker 주소 설정 필요");
      elements.lastSyncText.textContent = "config.js에 배포한 Worker 주소를 입력해 주세요.";
    } else {
      setSyncStatus("local", "이 기기에 저장 중");
    }
  }

  function bindEvents() {
    elements.checklist.addEventListener("change", (event) => {
      const input = event.target.closest("input[data-item-id]");
      if (!input) return;
      const now = new Date().toISOString();
      const entry = { checked: input.checked, updatedAt: now, clientId };
      entries[input.dataset.itemId] = entry;
      startAdaptiveSync();
      saveEntries();
      render();
      if (room && apiConfigured) queueServerChanges({ [input.dataset.itemId]: entry });
    });

    elements.searchInput.addEventListener("input", (event) => {
      searchTerm = event.target.value.trim().toLocaleLowerCase("ko");
      render();
    });

    document.querySelector(".filter-row").addEventListener("click", (event) => {
      const button = event.target.closest("[data-filter]");
      if (!button) return;
      activeFilter = button.dataset.filter;
      document.querySelectorAll("[data-filter]").forEach((chip) => {
        chip.classList.toggle("is-active", chip === button);
      });
      render();
    });

    elements.shareButton.addEventListener("click", handleShare);
    elements.syncButton.addEventListener("click", handleManualSync);
    elements.resetButton.addEventListener("click", resetAll);

    document.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        elements.searchInput.focus();
      }
    });

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        pausePolling();
      } else if (room && apiConfigured) {
        syncAfterResume();
      }
    });

    window.addEventListener("online", () => {
      if (room && apiConfigured) syncAfterResume();
    });

    window.addEventListener("offline", () => {
      pausePolling();
      setSyncStatus("offline", "오프라인 · 기기에 저장 중");
      updateLastSyncLabel();
    });

    window.addEventListener("beforeunload", () => {
      pausePolling();
      window.clearInterval(relativeTimeTimer);
    });
  }

  function render() {
    const checkedCount = allItems.filter((item) => isChecked(item.id)).length;
    const requiredItems = allItems.filter((item) => item.required);
    const requiredRemaining = requiredItems.filter((item) => !isChecked(item.id)).length;
    const percent = allItems.length ? Math.round((checkedCount / allItems.length) * 100) : 0;

    elements.progressText.textContent = `${checkedCount} / ${allItems.length} 완료`;
    elements.progressPercent.textContent = `${percent}%`;
    elements.progressFill.style.width = `${percent}%`;
    elements.progressTrack.setAttribute("aria-valuenow", String(percent));
    elements.requiredRemaining.textContent = requiredRemaining
      ? `필수 ${requiredRemaining}개 남음`
      : "필수 항목 완료";
    elements.completionMessage.textContent = completionMessage(percent);
    elements.allCount.textContent = String(allItems.length);
    elements.incompleteCount.textContent = String(allItems.length - checkedCount);
    elements.requiredCount.textContent = String(requiredItems.length);
    elements.completedCount.textContent = String(checkedCount);

    const sections = categories
      .map((category) => {
        const visibleItems = category.items.filter(matchesCurrentView);
        if (!visibleItems.length) return "";
        const categoryChecked = category.items.filter((item) => isChecked(item.id)).length;
        return `
          <article class="category" data-category-id="${category.id}">
            <header class="category__header">
              <span class="category__icon" aria-hidden="true">${category.icon}</span>
              <div class="category__heading">
                <h2>${escapeHtml(category.title)}</h2>
                <p>${escapeHtml(category.description)}</p>
              </div>
              <span class="category__progress">${categoryChecked}/${category.items.length}</span>
            </header>
            <ul class="category__items">
              ${visibleItems.map(renderItem).join("")}
            </ul>
          </article>`;
      })
      .join("");

    elements.checklist.innerHTML = sections;
    elements.emptyState.hidden = Boolean(sections);
  }

  function renderItem(item) {
    return `
      <li class="check-item">
        <div class="check-item__row">
          <label class="check-item__label">
            <input
              class="check-item__input"
              type="checkbox"
              data-item-id="${item.id}"
              ${isChecked(item.id) ? "checked" : ""}
            />
            <span class="check-item__box" aria-hidden="true"></span>
            <span class="check-item__title">${escapeHtml(item.title)}</span>
            ${item.required ? '<span class="required-badge">필수</span>' : ""}
          </label>
          ${
            item.url
              ? `<a class="check-item__action" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(item.title)} 공식 페이지 열기">작성하기 <span aria-hidden="true">↗</span></a>`
              : ""
          }
        </div>
      </li>`;
  }

  function matchesCurrentView(item) {
    const checked = isChecked(item.id);
    const filterMatch =
      activeFilter === "all" ||
      (activeFilter === "incomplete" && !checked) ||
      (activeFilter === "required" && item.required) ||
      (activeFilter === "completed" && checked);
    return filterMatch && (!searchTerm || item.title.toLocaleLowerCase("ko").includes(searchTerm));
  }

  function isChecked(id) {
    return entries[id]?.checked === true;
  }

  async function handleShare() {
    if (!apiConfigured) {
      showToast("먼저 config.js에 Cloudflare Worker 주소를 입력해 주세요.");
      return;
    }

    if (!room) {
      room = createRoomId();
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.set("room", room);
      window.history.replaceState({}, "", nextUrl);

      const migrated = {};
      const now = new Date().toISOString();
      allItems.forEach((item) => {
        if (entries[item.id]) {
          migrated[item.id] = entries[item.id];
        } else if (isChecked(item.id)) {
          migrated[item.id] = { checked: true, updatedAt: now, clientId };
        }
      });
      entries = migrated;
      saveEntries();
      updateRoomControls();
      if (Object.keys(entries).length) queueServerChanges(entries, true);
      startAdaptiveSync();
      syncNow({ force: true });
    }

    const copied = await copyText(window.location.href);
    showToast(copied ? "공유 링크를 복사했습니다." : "주소창의 링크를 복사해 주세요.");
  }

  async function handleManualSync() {
    const result = await syncNow({ force: true });
    if (result === "changed") startAdaptiveSync();
    else if (result === "unchanged" && !adaptiveSyncActive) enterManualMode();
  }

  async function syncAfterResume() {
    const result = await syncNow({ force: true });
    if (result === "changed") startAdaptiveSync();
    else if (result === "unchanged" && adaptiveSyncActive) scheduleAdaptivePoll();
    else if (result === "unchanged") enterManualMode();
  }

  async function syncNow({ force = false } = {}) {
    if (!room || !apiConfigured || document.hidden || !navigator.onLine || isSyncing) return "skipped";
    isSyncing = true;
    setSyncStatus("syncing", "동기화 중");

    try {
      const headers = {};
      if (lastEtag && !force) headers["If-None-Match"] = lastEtag;
      const response = await fetch(`${apiBaseUrl}/api/rooms/${room}`, { headers, cache: "no-store" });
      if (response.status === 304) {
        markSynced();
        return "unchanged";
      }
      if (!response.ok) throw new Error(`GET ${response.status}`);

      lastEtag = response.headers.get("ETag") || "";
      const remote = await response.json();
      const remoteItems = sanitizeEntries(remote.items || {});
      const localWins = {};
      let receivedRemoteChange = false;

      for (const id of itemIds) {
        const local = entries[id];
        const server = remoteItems[id];
        const winner = newerEntry(local, server);
        if (winner === server && server) {
          if (compareEntries(server, local) > 0) receivedRemoteChange = true;
          entries[id] = server;
        }
        if (winner === local && local && (!server || compareEntries(local, server) > 0)) {
          localWins[id] = local;
        }
      }

      saveEntries();
      render();
      markSynced();
      if (Object.keys(localWins).length) queueServerChanges(localWins);
      return receivedRemoteChange ? "changed" : "unchanged";
    } catch (error) {
      console.warn("동기화 실패:", error);
      setSyncStatus(navigator.onLine ? "error" : "offline", navigator.onLine ? "연결 재시도 중" : "오프라인 · 기기에 저장 중");
      updateLastSyncLabel();
      return "failed";
    } finally {
      isSyncing = false;
    }
  }

  function queueServerChanges(changes, immediate = false) {
    pendingChanges = { ...pendingChanges, ...changes };
    window.clearTimeout(flushTimer);
    const sinceLastWrite = Date.now() - lastWriteStartedAt;
    const delay = immediate || sinceLastWrite >= 1150 ? 0 : 1150 - sinceLastWrite;
    flushTimer = window.setTimeout(flushServerChanges, delay);
  }

  async function flushServerChanges() {
    if (!room || !apiConfigured || !Object.keys(pendingChanges).length) return;
    if (!navigator.onLine) {
      setSyncStatus("offline", "오프라인 · 기기에 저장 중");
      return;
    }

    const changes = pendingChanges;
    pendingChanges = {};
    lastWriteStartedAt = Date.now();
    setSyncStatus("syncing", "변경사항 저장 중");

    try {
      const response = await fetch(`${apiBaseUrl}/api/rooms/${room}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, changes }),
      });

      if (response.status === 429) {
        pendingChanges = { ...changes, ...pendingChanges };
        window.setTimeout(flushServerChanges, 1300);
        return;
      }
      if (!response.ok) throw new Error(`PUT ${response.status}`);

      const remote = await response.json();
      lastEtag = response.headers.get("ETag") || "";
      mergeRemote(remote.items || {});
      markSynced();
    } catch (error) {
      console.warn("저장 실패:", error);
      pendingChanges = { ...changes, ...pendingChanges };
      setSyncStatus(navigator.onLine ? "error" : "offline", navigator.onLine ? "저장 재시도 중" : "오프라인 · 기기에 저장 중");
    }
  }

  function mergeRemote(remoteItems) {
    const clean = sanitizeEntries(remoteItems);
    for (const [id, remote] of Object.entries(clean)) {
      const winner = newerEntry(entries[id], remote);
      if (winner === remote) entries[id] = remote;
    }
    saveEntries();
    render();
  }

  function compareEntries(a, b) {
    if (!a && !b) return 0;
    if (!a) return -1;
    if (!b) return 1;
    const timeDifference = Date.parse(a.updatedAt) - Date.parse(b.updatedAt);
    if (timeDifference !== 0) return timeDifference;
    return String(a.clientId || "").localeCompare(String(b.clientId || ""));
  }

  function newerEntry(a, b) {
    return compareEntries(a, b) >= 0 ? a : b;
  }

  function sanitizeEntries(raw) {
    const clean = {};
    if (!raw || typeof raw !== "object") return clean;
    for (const [id, entry] of Object.entries(raw)) {
      if (!itemIds.has(id) || !entry || typeof entry.checked !== "boolean") continue;
      const timestamp = new Date(entry.updatedAt);
      if (Number.isNaN(timestamp.getTime())) continue;
      clean[id] = {
        checked: entry.checked,
        updatedAt: timestamp.toISOString(),
        clientId: typeof entry.clientId === "string" ? entry.clientId.slice(0, 64) : "server",
      };
    }
    return clean;
  }

  function resetAll() {
    if (!window.confirm("모든 체크를 해제할까요? 공유방의 동행자 화면에도 반영됩니다.")) return;
    const now = new Date().toISOString();
    const changes = {};
    allItems.forEach((item) => {
      changes[item.id] = { checked: false, updatedAt: now, clientId };
    });
    entries = { ...entries, ...changes };
    startAdaptiveSync();
    saveEntries();
    render();
    if (room && apiConfigured) queueServerChanges(changes, true);
    showToast("모든 체크를 초기화했습니다.");
  }

  function updateRoomControls() {
    elements.shareButtonText.textContent = room ? "공유 링크 복사" : "공유 시작";
    elements.syncButton.hidden = !(room && apiConfigured);
    if (room && apiConfigured && !lastSyncedAt) {
      elements.lastSyncText.textContent = "처음 한 번 확인한 뒤 기본은 수동 동기화입니다.";
    }
  }

  function startAdaptiveSync() {
    if (!room || !apiConfigured) return;
    adaptiveSyncActive = true;
    pollStep = 0;
    pollingGeneration += 1;
    scheduleAdaptivePoll();
  }

  function scheduleAdaptivePoll() {
    pausePolling();
    if (!adaptiveSyncActive || document.hidden || !navigator.onLine) return;
    if (pollStep >= pollSchedule.length) {
      enterManualMode();
      return;
    }

    const generation = pollingGeneration;
    const delay = pollSchedule[pollStep];
    nextPollAt = Date.now() + delay;
    pollTimer = window.setTimeout(async () => {
      pollTimer = null;
      nextPollAt = null;
      const result = await syncNow();
      if (!adaptiveSyncActive || generation !== pollingGeneration) return;
      if (result === "changed") {
        startAdaptiveSync();
        return;
      }
      if (result === "failed" || result === "skipped") {
        scheduleAdaptivePoll();
        if (result === "failed") setSyncStatus("error", "연결 재시도 대기 중");
        return;
      }
      pollStep += 1;
      scheduleAdaptivePoll();
    }, delay);
    setSyncStatus("online", "온라인 · 가변 동기화 중");
    updateLastSyncLabel();
  }

  function pausePolling() {
    window.clearTimeout(pollTimer);
    pollTimer = null;
    nextPollAt = null;
  }

  function enterManualMode() {
    pausePolling();
    adaptiveSyncActive = false;
    pollStep = 0;
    pollingGeneration += 1;
    if (room && apiConfigured && navigator.onLine) {
      setSyncStatus("online", "온라인 · 수동 모드");
    }
    updateLastSyncLabel();
  }

  function markSynced() {
    lastSyncedAt = new Date();
    setSyncStatus("online", adaptiveSyncActive ? "온라인 · 가변 동기화 중" : "온라인 · 동기화됨");
    updateLastSyncLabel();
  }

  function setSyncStatus(state, text) {
    elements.syncStatus.dataset.state = state;
    elements.syncStatusText.textContent = text;
  }

  function updateLastSyncLabel() {
    if (!lastSyncedAt) return;
    const seconds = Math.max(0, Math.round((Date.now() - lastSyncedAt.getTime()) / 1000));
    let relative = "방금 전";
    if (seconds >= 60) relative = `${Math.floor(seconds / 60)}분 전`;
    if (adaptiveSyncActive && nextPollAt) {
      const remainingSeconds = Math.max(1, Math.ceil((nextPollAt - Date.now()) / 1000));
      elements.lastSyncText.textContent = `마지막 동기화 ${relative} · 다음 자동 확인 ${formatDuration(remainingSeconds)}`;
    } else {
      elements.lastSyncText.textContent = `마지막 동기화 ${relative} · 수동 동기화 모드`;
    }
  }

  function normalizePollSchedule(value, fallback) {
    const source = Array.isArray(value) && value.length ? value : fallback;
    return source.slice(0, 6).map((interval, index) => {
      const fallbackInterval = fallback[index] || fallback[fallback.length - 1];
      return Math.min(Math.max(Number(interval) || fallbackInterval, 5000), 3600000);
    });
  }

  function formatDuration(seconds) {
    if (seconds < 60) return `${seconds}초 후`;
    return `${Math.ceil(seconds / 60)}분 후`;
  }

  function loadEntries(targetRoom) {
    try {
      const raw = window.localStorage.getItem(storageKey(targetRoom));
      return sanitizeEntries(raw ? JSON.parse(raw) : {});
    } catch {
      return {};
    }
  }

  function saveEntries() {
    try {
      window.localStorage.setItem(storageKey(room), JSON.stringify(entries));
    } catch (error) {
      console.warn("로컬 저장 실패:", error);
    }
  }

  function storageKey(targetRoom) {
    return `nha-trang-checklist:v2:${targetRoom || "local"}`;
  }

  function getOrCreateClientId() {
    const key = "nha-trang-checklist:client-id";
    try {
      const saved = window.localStorage.getItem(key);
      if (/^[A-Za-z0-9_-]{12,64}$/.test(saved || "")) return saved;
      const created = createRandomToken(12);
      window.localStorage.setItem(key, created);
      return created;
    } catch {
      return createRandomToken(12);
    }
  }

  function createRoomId() {
    return createRandomToken(24);
  }

  function createRandomToken(byteLength) {
    const bytes = new Uint8Array(byteLength);
    window.crypto.getRandomValues(bytes);
    let binary = "";
    bytes.forEach((byte) => (binary += String.fromCharCode(byte)));
    return window.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      area.select();
      const copied = document.execCommand("copy");
      area.remove();
      return copied;
    }
  }

  function completionMessage(percent) {
    if (percent === 100) return "준비 완료! 즐거운 여행만 남았어요.";
    if (percent >= 75) return "거의 다 왔어요!";
    if (percent >= 40) return "차근차근 잘 준비하고 있어요.";
    if (percent > 0) return "좋은 시작이에요.";
    return "준비를 시작해 볼까요?";
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function showToast(message) {
    window.clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.classList.add("is-visible");
    toastTimer = window.setTimeout(() => elements.toast.classList.remove("is-visible"), 2600);
  }
})();
