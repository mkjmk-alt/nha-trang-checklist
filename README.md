# 나트랑 공동 여행 준비 체크리스트

GitHub Pages에서 웹 화면을 무료로 호스팅하고, Cloudflare Worker + Workers KV에 공유방별 체크 상태를 저장하는 정적 웹앱입니다. 회원가입 없이 충분히 긴 비공개 링크를 공유하면 두 사람이 같은 체크 상태를 볼 수 있습니다.

## 현재 배포 주소

- 웹앱: <https://mkjmk-alt.github.io/nha-trang-checklist/>
- Worker API: <https://nha-trang-checklist-api.mkjmk3114.workers.dev>
- GitHub 저장소: <https://github.com/mkjmk-alt/nha-trang-checklist>

Worker의 CORS는 현재 GitHub Pages 출처인 `https://mkjmk-alt.github.io`로 제한되어 있습니다.

## 포함된 기능

- 14개 카테고리, 116개 준비 항목, 필수 항목 표시
- 전체·카테고리별 진행률
- 전체 / 미완료 / 필수 / 완료 필터와 검색
- 브라우저 `localStorage` 자동 저장과 전체 초기화
- 32자의 암호학적 랜덤 room 토큰이 포함된 공유 링크
- 체크 즉시 서버 저장, 활동에 따라 30→60→180초로 느려지는 가변 폴링
- 탭/앱이 백그라운드로 가면 폴링 중지, 복귀 시 즉시 동기화
- 오프라인 로컬 저장과 온라인 복귀 시 재동기화
- 온라인·동기화 중·오프라인 상태 및 마지막 동기화 시간 표시
- 항목별 수정 시각 기반 최신 수정 우선 병합
- 모바일, 데스크톱, 인쇄 레이아웃

## 폴더 구조

```text
.
├── index.html           # GitHub Pages 화면
├── styles.css
├── checklist.js        # 변경이 적은 체크리스트 정의
├── config.js           # 배포한 Worker 주소 입력
├── app.js              # UI, localStorage, 동기화
└── worker/
    ├── src/index.js    # GET/PUT API, CORS, 검증, 병합
    ├── test/           # Worker 단위 테스트
    ├── package.json
    └── wrangler.jsonc  # Worker + KV 설정
```

## 1. Cloudflare Worker와 KV 배포

필요한 것: 무료 Cloudflare 계정, Node.js 20 이상.

터미널에서 프로젝트의 `worker` 폴더로 이동한 뒤 실행합니다.

```bash
cd worker
npm install
npx wrangler login
npm test
npm run deploy
```

현재 저장소의 `wrangler.jsonc`는 배포된 KV namespace ID가 연결되어 있습니다. 새 Cloudflare 계정에서 처음 배포할 때는 `id` 줄을 제거하면 Wrangler가 `CHECKLIST_KV`용 KV namespace를 자동 프로비저닝할 수 있습니다. 배포가 끝나면 다음과 같은 주소가 표시됩니다.

```text
https://nha-trang-checklist-api.<내-subdomain>.workers.dev
```

이 주소를 복사합니다.

자동 생성이 계정 환경에서 동작하지 않을 때만 수동으로 만듭니다.

```bash
npx wrangler kv namespace create CHECKLIST_KV
```

출력된 `id`를 `worker/wrangler.jsonc`의 KV 항목에 추가합니다.

```jsonc
"kv_namespaces": [
  {
    "binding": "CHECKLIST_KV",
    "id": "출력된-namespace-id"
  }
]
```

그다음 `npm run deploy`를 다시 실행합니다.

## 2. 웹앱에 Worker 주소 연결

루트의 `config.js`를 열어 배포 결과 주소를 입력합니다.

```js
window.NHA_TRANG_CONFIG = {
  apiBaseUrl: "https://nha-trang-checklist-api.<내-subdomain>.workers.dev",
  pollIntervalsMs: {
    active: 30000,
    idle: 60000,
    longIdle: 180000,
  },
  idleAfterMs: 120000,
  longIdleAfterMs: 600000,
};
```

페이지 진입·새로고침·화면 복귀·온라인 복구 시에는 즉시 동기화합니다. 이후 최근 2분 동안 활동이 있으면 30초, 2~10분 동안 변화가 없으면 60초, 10분 이상 변화가 없으면 180초 간격으로 확인합니다. 체크하거나 상대방의 새 변경을 받으면 다시 30초 단계로 돌아갑니다.

### 선택: CORS를 내 GitHub Pages로 제한

처음에는 쉬운 배포를 위해 `worker/wrangler.jsonc`의 `ALLOWED_ORIGINS`가 `*`입니다. GitHub Pages 주소를 안 뒤에는 다음처럼 바꿀 수 있습니다.

```jsonc
"vars": {
  "ALLOWED_ORIGINS": "https://<github-id>.github.io"
}
```

여러 출처를 허용하려면 쉼표로 구분합니다. 바꾼 뒤 `worker` 폴더에서 `npm run deploy`를 다시 실행합니다.

## 3. GitHub Pages 배포

1. GitHub에서 새 **public repository**를 만듭니다.
2. 이 프로젝트 폴더 안의 파일과 `worker` 폴더를 저장소 루트에 올립니다.
3. 저장소의 **Settings → Pages**로 이동합니다.
4. **Build and deployment → Source**를 `Deploy from a branch`로 선택합니다.
5. Branch는 `main`, 폴더는 `/(root)`를 선택하고 저장합니다.
6. 몇 분 뒤 표시되는 `https://<github-id>.github.io/<repository>/` 주소를 엽니다.

Git 명령을 사용한다면 새 저장소 주소를 넣어 다음처럼 올릴 수 있습니다.

```bash
git init
git add .
git commit -m "Add Nha Trang shared checklist"
git branch -M main
git remote add origin https://github.com/<github-id>/<repository>.git
git push -u origin main
```

## 4. 배포 후 사용 흐름

1. 처음 사이트를 연 사람은 혼자 체크해도 됩니다. 이때 상태는 해당 브라우저의 localStorage에 저장됩니다.
2. 상단의 **공유 시작**을 누르면 192비트 랜덤 room 토큰이 URL에 추가되고 현재 상태가 Worker/KV로 올라갑니다.
3. **공유 링크 복사**로 링크를 복사해 카카오톡 등으로 동행자에게 보냅니다.
4. 동행자가 같은 링크를 열면 같은 room 상태를 불러옵니다.
5. 체크할 때마다 첫 변경은 즉시 PUT으로 저장됩니다. 연속 클릭은 KV의 동일 키 쓰기 특성을 고려해 약 1.15초 단위로 묶습니다.
6. 상대 화면은 활동 중 30초, 유휴 시 60~180초 간격으로 갱신됩니다. 앱을 백그라운드로 보내면 폴링을 멈추고, 돌아오거나 새로고침하면 즉시 최신 상태를 확인합니다.
7. 인터넷이 끊기면 로컬에 계속 저장합니다. 연결이 돌아오면 항목별 `updatedAt`을 비교해 더 최신인 변경을 서버로 보냅니다.

```text
내 휴대폰 ── 체크 즉시 PUT ──▶ Cloudflare Worker ──▶ room별 KV JSON
     ▲                                      │
     └──── 화면 표시 중 30→60→180초 GET ────┘
                                            ▲
동행자 휴대폰 ───────────────────────────────┘
```

## API 형식

### `GET /api/rooms/:room`

없는 방도 `200`과 빈 상태를 반환합니다. `ETag` / `If-None-Match`를 지원합니다.

```json
{
  "schemaVersion": 1,
  "version": 3,
  "updatedAt": "2026-08-10T10:10:00.000Z",
  "items": {
    "priority-passport": {
      "checked": true,
      "updatedAt": "2026-08-10T10:09:58.000Z",
      "clientId": "random-client-id"
    }
  }
}
```

### `PUT /api/rooms/:room`

전체 문서가 아니라 바뀐 항목만 보냅니다.

```json
{
  "clientId": "random-client-id",
  "changes": {
    "priority-passport": {
      "checked": true,
      "updatedAt": "2026-08-10T10:09:58.000Z",
      "clientId": "random-client-id"
    }
  }
}
```

Worker는 기존 room JSON과 항목별로 병합하며, `updatedAt`이 같으면 `clientId`를 결정적 tie-breaker로 씁니다. 5분보다 먼 미래 시각은 서버 기준으로 제한합니다. KV는 강한 트랜잭션 저장소가 아니므로 완전한 동시 편집 보장은 아니지만, 두 명이 준비물을 간헐적으로 체크하는 용도의 충돌 손실을 크게 줄입니다.

## 보안과 운영 참고

- 공유 링크를 가진 사람은 누구나 읽고 수정할 수 있습니다. 링크를 공개 게시물에 올리지 마세요.
- room ID는 브라우저의 `crypto.getRandomValues()`로 만든 24바이트(192비트) 난수이며 URL-safe Base64로 32자가 됩니다.
- 저장되는 것은 room 토큰, 체크 여부, 수정 시각, 임의 client ID뿐입니다. 이름·이메일·여권정보는 저장하지 않습니다.
- 공개 편집 링크 방식은 별도 로그인이나 복구 기능이 없습니다. 링크를 잃으면 같은 방에 다시 접근할 수 없습니다.
- Cloudflare KV는 수초 안에 전 세계에 항상 즉시 반영되는 강한 일관성 DB가 아닙니다. 이 앱은 폴링과 항목별 병합으로 준실시간 사용감을 제공합니다.
- 무료 플랜 한도를 넘으면 요청이 제한될 수 있습니다. 개인 여행 체크리스트 규모에서는 일반적으로 매우 작은 사용량입니다.

## 체크리스트 항목 수정

`checklist.js`의 카테고리와 항목을 수정합니다. 항목 ID는 서버에 저장되는 키이므로 배포 후에는 기존 ID를 바꾸지 않는 것이 좋습니다.

```js
["고유한-item-id", "화면에 보일 문구", true] // true = 필수
```

## 로컬 미리보기

정적 파일은 단순 HTTP 서버로 확인할 수 있습니다.

```bash
python3 -m http.server 8080
```

`http://localhost:8080`을 엽니다. Worker까지 로컬에서 시험하려면 별도 터미널에서 `worker` 폴더의 `npm run dev`를 실행하고, `config.js`의 주소를 로컬 Worker 주소로 잠시 바꿉니다.
