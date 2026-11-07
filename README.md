# CRYPTO FLOW

바이낸스 선물·업비트 원화 12분할 차트, 김프 차트, 거래소별 현선갭 감시를 한 앱으로 합친 프로젝트입니다. 모든 화면은 **조회 전용**이며 주문 기능이 없고 투자 조언이 아닙니다.

| 화면 | 주소 | 원래 프로젝트 |
| --- | --- | --- |
| BINANCE | `/binance` | `binance-futures-flow` (그대로 옮김) |
| UPBIT | `/upbit` | `upbit-flow` (그대로 옮김) |
| 김프 | `/kimp` | `gap-watch/spot_gap_chart.py` (파이썬 → TypeScript) |
| 현선갭 | `/basis` | `gap-watch/gap_alert.py` (파이썬 → TypeScript) |

- `/`로 들어오면 `/binance`로 넘어갑니다.
- 네 화면 모두 상단 오른쪽 전환 메뉴로 오갑니다.
- 밝은/어두운 테마는 네 화면이 함께 씁니다(저장 키 `crypto-flow-theme`). 예전 두 앱에서 고른 테마도 처음 한 번은 그대로 읽습니다.
- 바이낸스·업비트 화면의 레이아웃 저장 키는 예전 그대로입니다. 같은 주소(`localhost:3000`)에서 쓰던 배치가 있으면 이어서 보입니다.

## 실행

필수 환경은 Node.js `20.9` 이상입니다.

```bash
npm install
npm run dev
```

브라우저에서 `http://localhost:3000`을 엽니다. 키 없이도 모든 차트와 김프·현선갭 화면이 동작합니다. 업비트 잔고(BALANCE 탭)만 키가 필요합니다.

검증:

```bash
npm test      # next build 후 tests/*.test.mjs 전체 실행
npm run lint
```

## 환경 변수

`.env.example`을 `.env.local`로 복사해 씁니다. 모두 선택 항목입니다.

| 변수 | 설명 |
| --- | --- |
| `BINANCE_API_KEY` | 서버가 보낼 수 있는 API 키. 공개 시장 데이터에는 필요 없습니다. |
| `BINANCE_FUTURES_REST_URL` | Binance USDⓈ-M REST 기본 주소. 기본값 `https://fapi.binance.com` |
| `BINANCE_FUTURES_REST_FALLBACK_URLS` | 직접 검증한 대체 REST 주소(쉼표로 최대 3개) |
| `UPBIT_ACCESS_KEY`, `UPBIT_SECRET_KEY` | 업비트 잔고 조회용. 둘 다 있어야 BALANCE 탭이 켜집니다. |
| `UPBIT_REST_URL`, `UPBIT_REST_FALLBACK_URLS` | 업비트 REST 기본·대체 주소 |
| `UPBIT_REQUEST_TIMEOUT_MS` | 업비트 REST 제한 시간(1,000~30,000ms, 기본 8,000) |

키는 서버 런타임에서만 읽습니다. `NEXT_PUBLIC_*` 변수, 브라우저 코드, 로그, URL, 커밋에 넣지 마세요.

> **업비트 키를 넣은 채 공개 주소에 배포하지 마세요.** `/api/upbit/accounts`는 별도 인증 없이 응답하므로, 주소를 아는 누구나 잔고를 볼 수 있습니다. 업비트 키는 등록한 허용 IP에서만 동작하므로 잔고 패널은 로컬이나 고정 IP 서버에서 쓰는 것을 전제로 합니다.

## 구조

```text
app/
  binance/page.tsx, upbit/page.tsx, kimp/page.tsx, basis/page.tsx
  api/binance/{chart-universe,charts,radar}     바이낸스 (예전 /api/*)
  api/upbit/{accounts,chart-universe,charts,radar}  업비트 (예전 /api/*)
  api/kimp/{data,live}                          김프
  api/basis                                     현선갭
components/
  binance/  upbit/       예전 두 앱의 화면 (API 경로와 전환 메뉴만 바뀜)
  kimp/  basis/          새 화면
  shared/                전환 메뉴(SectionSwitcher), 김프·현선갭 공통 바탕(FlowFrame)
lib/                     거래소 클라이언트와 계산 로직 (spot-gap, basis-gap, basis-alerts 추가)
tests/                   두 앱의 기존 테스트 + 김프·현선갭 테스트
tools/gap-watch/         창을 닫아도 도는 현선갭 알림(파이썬)
```

## 김프 화면 (`/kimp`)

- **계산식**: (업비트 환산가 − 해외 가격) ÷ 해외 가격 × 100
  - 업비트 환산가는 `KRW-코인 ÷ KRW-USDT`이며, 같은 봉의 종가끼리 계산합니다.
  - 양수면 업비트가 더 비쌉니다.
- **비교 거래소**: 바이낸스, 바이빗, 비트겟, 게이트, OKX의 USDT 현물
- **조건**: 코인(업비트 KRW 마켓 티커), 봉(1분·5분·15분·1시간), 기간(1~60일)
  - 선택값은 주소창(`?coin=XRP&interval=15&days=7`)에 남습니다.
  - 한 번에 받는 봉은 1,000개라서 1분봉은 약 17시간, 15분봉은 약 10일까지 보입니다.
- **갱신**:
  - 2초마다 현재가로 마지막 봉을 움직입니다.
  - 60초마다 봉 이력을 다시 받습니다.
  - 업비트에 아직 마켓이 없거나 첫 체결 전이면 5초마다 다시 조회하다가, 체결되는 즉시 그립니다.
- **범례**: 거래소 이름을 누르면 선을 켜고 끕니다. 끈 상태는 다음에 열어도 유지됩니다.
- **제외 표시**: 상장되지 않은 거래소와, 티커만 같은 다른 코인으로 보이는 거래소(갭 −50% 미만 또는 +300% 초과)는 선을 그리지 않고 표에 이유를 적습니다.

## 현선갭 화면 (`/basis`)

- **계산식**: (현물 − 선물) ÷ 선물 × 100. 같은 거래소의 USDT 현물과 USDT 무기한 선물을 비교합니다.
- **대상**: 바이낸스, OKX, 바이빗, 비트겟, 게이트, 쿠코인, MEXC, HTX. 10초마다 갱신합니다.
- **제외**:
  - 현물 24h 거래대금 10만 USDT 미만, 선물 100만 USDT 미만
  - |갭| 50% 초과
- `1000PEPE`처럼 배수 단위로 상장된 선물은 1코인 가격으로 나눠 현물과 맞춥니다.
- **알림 규칙**: 기본 |갭| 3% 이상
  - 같은 거래소·코인은 10분 동안 다시 알리지 않습니다.
  - 그 사이 2%p 더 벌어지면 다시 알립니다.
- **소리와 윈도우 알림**
  - 소리는 화면 안에서 직접 내며, **볼륨 슬라이더로 크기를 조절**합니다. 윈도우 알림음 설정과 무관합니다.
  - 윈도우 알림을 켜면 **무음(silent)** 으로 띄워 윈도우 기본 알림음이 겹치지 않게 합니다.
  - 브라우저는 페이지를 한 번이라도 누르기 전에는 소리를 막습니다. 화면을 한 번 클릭하거나 "알림 테스트"를 누르세요.
- 설정(기준, 거래소, 소리, 볼륨, 윈도우 알림)은 브라우저에 저장됩니다.
- **이 화면이 열려 있을 때만 알립니다.** 창을 닫아도 알림을 받으려면 아래 파이썬 도구를 쓰세요.

### 백그라운드 알림 (`tools/gap-watch/gap_alert.py`)

파이썬 표준 라이브러리만 씁니다. 같은 규칙으로 콘솔 출력과 비프음을 내고, 텔레그램으로도 보낼 수 있습니다.

```bash
python tools/gap-watch/gap_alert.py --once   # 현재 갭 상위 종목을 한 번만 출력
python tools/gap-watch/gap_alert.py          # 상시 감시 (Ctrl+C로 종료)
```

텔레그램으로 받으려면 환경 변수 `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`를 설정합니다.

## 바이낸스·업비트 화면

예전 두 앱의 기능을 그대로 옮겼습니다. 바뀐 점은 세 가지입니다.

- API 주소: `/api/*` → `/api/binance/*`, `/api/upbit/*`
- 상단에 화면 전환 메뉴 추가
- 테마 저장 키 통합

**공통 동작**

- C1·C2는 사용자가 지정한 종목을 유지합니다.
- C3~C12는 24시간 거래대금 상위 10종목으로 1시간마다 자동 배열합니다.
- `RADAR` 탭은 거래대금 규모·최근 거래대금 강도·전일 대비 가격 변화를 5:3:2로 평가합니다.
- 최초 과거 봉은 REST로 채우고, 이후 봉은 공개 WebSocket으로 갱신합니다.
- 서버 REST가 실패하면 브라우저가 공개 REST로 직접 복구합니다.

## 배포 (Vercel)

이 저장소는 원래 BINANCE FUTURES FLOW 저장소이며, `master` 브랜치가 Vercel(`binance-futures-flow.vercel.app`)로 자동 배포됩니다.

- `vercel.json`이 서버 함수 지역을 서울(`icn1`)로 지정합니다. Vercel 기본 지역은 미국(`iad1`)인데, 바이낸스·바이빗 같은 거래소는 미국 접속을 막아 김프·현선갭 API가 데이터를 받지 못합니다. Hobby 플랜은 지역을 하나만 고를 수 있습니다.
- 바이낸스·업비트 차트는 서버 조회가 실패해도 브라우저가 공개 REST로 직접 받아 오는 경로가 있습니다.
- **Vercel에는 업비트 키를 넣지 마세요.** 공개 주소에서 잔고가 노출되고, 업비트 키는 등록한 IP에서만 동작합니다. 잔고 탭은 로컬 실행에서만 씁니다.

이 앱은 원래 따로 있던 `upbit-flow`와 `gap-watch`를 이 저장소로 합친 것입니다.
