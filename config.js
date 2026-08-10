/**
 * 배포된 Cloudflare Worker API 주소입니다.
 */
window.NHA_TRANG_CONFIG = {
  apiBaseUrl: "https://nha-trang-checklist-api.mkjmk3114.workers.dev",
  pollIntervalsMs: {
    active: 30000,
    idle: 60000,
    longIdle: 180000,
  },
  idleAfterMs: 120000,
  longIdleAfterMs: 600000,
};
