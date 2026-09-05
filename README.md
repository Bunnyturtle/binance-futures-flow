# BINANCE FUTURES FLOW

Binance USDⓈ-M의 거래 가능한 USDT 무기한 선물을 12개 슬롯에서 감시하는 실시간 다중 차트입니다. `CRYPTO`와 `TRADFI` 모두 C1·C2는 사용자가 자유롭게 변경하거나 비울 수 있으며 이후에도 선택값을 그대로 유지합니다. 새 `CRYPTO` 레이아웃만 C1과 C2가 각각 BTCUSDT와 ETHUSDT로 시작하고, 새 `TRADFI` 레이아웃의 C1·C2는 비어 있습니다. 두 시장의 C3~C12는 전체 거래 가능 종목의 24시간 거래대금 순위에서 현재 C1·C2 종목을 제외한 상위 10종목으로 시작 즉시 구성합니다. 동적 10종목은 시장별로 1시간마다 자동 재배치되며 C1·C2, 봉 주기와 활성 슬롯은 그대로 유지됩니다. 두 시장의 검색창은 모두 24시간 거래대금 순으로 후보를 보여 주며, `RADAR` 탭은 두 시장을 합쳐 거래대금 규모·최근 거래대금 강도·전일 대비 가격 변화를 5:3:2로 평가한 관심 후보를 보여 줍니다. 최초 과거 봉은 Binance REST API로 채우고, 이후 봉은 공개 WebSocket combined stream으로 갱신합니다. 표시 데이터는 시장 정보이며 주문 기능이나 투자 조언을 제공하지 않습니다.

이 저장소는 표준 **Next.js (App Router)** 프로젝트입니다. 특정 호스팅 벤더에 종속된 빌드 도구 없이 `next dev` / `next build` / `next start`만으로 동작하며, Vercel · Netlify · Node 서버 어디에나 그대로 배포할 수 있습니다.

## 로컬 실행

필수 환경은 Node.js `20.9` 이상입니다.

```bash
cp .env.example .env.local
npm install
npm run dev
```

브라우저에서 `http://localhost:3000`을 엽니다. 공개 시세만 볼 때는 `.env.local`의 `BINANCE_API_KEY`를 비워 두어도 됩니다.

프로덕션 빌드와 전체 검증은 다음 명령으로 실행합니다.

```bash
npm run build
npm test
npm run lint
```

## Vercel 배포

1. 이 저장소를 GitHub에 푸시합니다.
2. [vercel.com](https://vercel.com)에서 New Project → 해당 GitHub 저장소를 선택합니다. 프레임워크는 Next.js로 자동 인식됩니다.
3. 환경 변수는 선택 사항입니다. 공개 시세만 사용하면 아무것도 설정하지 않아도 됩니다. 필요하면 `BINANCE_FUTURES_REST_URL`, `BINANCE_FUTURES_REST_FALLBACK_URLS`, `BINANCE_API_KEY`를 Vercel 프로젝트의 Environment Variables에 추가합니다.
4. Deploy를 누르면 끝입니다. 이후 `main` 브랜치에 푸시할 때마다 자동으로 재배포됩니다.

CLI로 직접 배포하려면:

```bash
npm install -g vercel
vercel login
vercel        # 프리뷰 배포
vercel --prod # 프로덕션 배포
```

## 환경 변수

| 변수 | 필수 여부 | 설명 |
| --- | --- | --- |
| `BINANCE_FUTURES_REST_URL` | 선택 | Binance USDⓈ-M REST 기본 주소입니다. 기본값은 `https://fapi.binance.com`입니다. |
| `BINANCE_FUTURES_REST_FALLBACK_URLS` | 선택 | 운영자가 직접 검증하고 승인한 대체 REST 주소를 쉼표로 최대 3개 지정합니다. 기본값은 비어 있습니다. |
| `BINANCE_API_KEY` | 선택 | 서버가 보낼 수 있는 API 키입니다. 이 프로젝트가 사용하는 공개 시장 데이터에는 필요하지 않습니다. |

`.env.example`을 `.env.local`로 복사해 사용하세요. `BINANCE_API_KEY`는 서버 런타임 전용입니다. `NEXT_PUBLIC_*` 변수, 브라우저 코드, 로그, URL, 커밋에 키를 넣지 마세요. 이 앱은 API secret을 요구하지 않습니다.

## 구조와 데이터 흐름

```text
브라우저
  ├─ GET /api/chart-universe?segment=crypto|tradfi
  │    └─ 서버 → exchangeInfo + ticker/24hr
  │              ├─ CRYPTO: 검색 후보와 C3~C12 자동 배열 모두 24시간 거래대금순, C1·C2 사용자 지정 유지
  │              └─ TRADFI: 검색 후보와 C3~C12 자동 배열 모두 24시간 거래대금순, C1·C2 사용자 지정 유지
  ├─ POST /api/charts
  │    └─ 서버 → 종목별 REST klines 200개와 현재 가격
  ├─ GET /api/radar
  │    └─ CRYPTO + TRADFI 통합 USDT 무기한 선물
  │         ├─ ticker/24hr 거래대금 상위 40개 분석
  │         ├─ 완료된 30일 일봉 거래대금 이력
  │         └─ 50:30:20 관심 점수 상위 20개
  ├─ 서버 REST 실패 시 공개 REST 직접 복구
  │    └─ exchangeInfo + ticker/24hr + 선택 종목/레이더 일봉 klines
  └─ 공개 combined WebSocket
       └─ 화면에 보이는 종목의 kline stream을 실시간 병합
```

- `app/api/chart-universe`: `crypto`와 `tradfi` 검색 후보 및 자동 배열 순위는 모두 24시간 거래대금 내림차순입니다. 새 CRYPTO 레이아웃만 C1은 BTCUSDT, C2는 ETHUSDT로 시작하고 새 TRADFI 레이아웃의 두 슬롯은 비어 있습니다. 두 시장의 C1·C2는 이후 사용자가 지정한 값을 유지하며 C3~C12는 거래대금 순위에서 현재 C1·C2의 비어 있지 않은 종목을 제외한 상위 10개로 시작 즉시 구성된 뒤 시장별로 1시간마다 갱신됩니다.
- `app/api/charts`: 선택한 최대 12개 종목을 검증하고 과거 OHLCV를 반환합니다.
- `app/api/radar`: CRYPTO `PERPETUAL`과 TRADFI `TRADIFI_PERPETUAL`을 한 모집단으로 합친 뒤 최종 관심 후보 20개를 반환합니다. USDⓈ-M의 `TRADING`, quote·margin asset이 모두 `USDT`인 계약만 포함하므로 현물·USDC·COIN-M·인도물은 제외됩니다.
- `lib/binance-client.ts`: Binance 응답 검증, 전체 심볼 카탈로그, 가격 단위(`tickSize`), 오류 변환과 TTL/single-flight 캐시를 담당합니다.
- 브라우저 직접 복구는 API 키나 인증 헤더 없이 `fapi.binance.com`의 공개 GET 경로만 사용합니다. 서버 환경 변수는 클라이언트 번들로 전달되지 않습니다.
- 네트워크 오류가 생기면 마지막 정상 차트를 유지하고 REST 재조회 및 WebSocket 재연결을 시도합니다. 두 REST 경로가 모두 실패할 때만 `DELAYED`로 표시합니다.

## 관심 종목 레이더

레이더는 단순 24시간 거래대금 순위가 아닙니다. 거래대금 규모는 전체 거래 가능 USDT 무기한 선물에서, 이력이 필요한 주간 강도와 전일 대비 값은 거래대금 상위 40개 분석군에서 중간순위 백분위수를 계산한 뒤 다음 비중으로 합산합니다.

- 거래대금 규모 50%: 현재 rolling 24시간 `quoteVolume`
- 주간 거래대금 강도 30%: 완료된 최근 7일 일평균 `quoteVolume` ÷ 최근 30일 일평균 `quoteVolume`
- 전일 대비 20%: 현재 가격 ÷ 가장 최근 완료된 UTC 일봉 종가의 가격 변화

## Binance 공식 엔드포인트

REST 기본 주소: `https://fapi.binance.com`

사용하는 공개 REST 경로:

- `GET /fapi/v1/exchangeInfo`
- `GET /fapi/v1/ticker/24hr`
- `GET /fapi/v2/ticker/price`
- `GET /fapi/v1/klines`

WebSocket: `wss://fstream.binance.com/market/stream?streams=btcusdt@kline_1m/ethusdt@kline_1m`

앱에서 선택할 수 있는 시간봉: `1m 3m 5m 15m 1h 4h 1d 1w 1M`

## 안전 및 운영 주의사항

- `exchangeInfo`, `ticker/24hr`, `klines`, 공개 market stream에는 API 키가 필요하지 않습니다. 키를 비워 두는 구성이 가장 안전합니다.
- REST 응답의 `X-MBX-USED-WEIGHT-*`와 HTTP `429`/`Retry-After`를 존중하세요.
- WebSocket 한 연결은 최대 24시간 유지됩니다. ping/pong을 처리하고 종료 시 backoff와 jitter를 적용해 재연결하세요.
- 한 WebSocket 연결은 최대 1024개 stream, 클라이언트가 보내는 제어 메시지는 초당 최대 10개입니다.

## 문제 해결

### 차트가 비어 있거나 `DELAYED`로 표시됨

1. `https://fapi.binance.com/fapi/v1/ping`이 현재 네트워크에서 열리는지 확인합니다.
2. 서버 로그에서 `429`, `451`, timeout 또는 DNS 오류를 확인합니다.
3. `.env.local`을 바꿨다면 개발 서버를 다시 시작합니다.
4. 브라우저 확장 프로그램이나 사내 프록시가 `wss://fstream.binance.com/market`을 차단하지 않는지 확인합니다.

### 빌드 결과가 예상과 다름

```bash
npm test
```

이 명령은 먼저 프로덕션 빌드를 만든 뒤 `tests/*.test.mjs` 전체를 실행해 Binance 페이지의 서버 렌더링 제목, 핵심 문구와 Open Graph 메타데이터를 확인합니다.
