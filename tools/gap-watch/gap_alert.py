"""거래소별 현선갭 알림.

갭(%) = (현물 - 선물) / 선물 * 100   (트레이딩뷰 수식 (XXXUSDT-XXXUSDT.P)/XXXUSDT.P*100 과 동일)
같은 거래소 안의 USDT 현물과 USDT 무기한 선물을 비교한다.

실행:  python gap_alert.py          (상시 감시)
       python gap_alert.py --once   (현재 갭 상위 종목만 1회 출력)
텔레그램 알림을 쓰려면 환경변수 TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID 를 설정한다.
설정하지 않으면 콘솔 출력 + 비프음으로만 알린다.
"""
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

# ── 설정 ─────────────────────────────────────────────
EXCHANGES = ["Binance", "OKX", "Bybit", "Bitget", "Gate", "KuCoin", "MEXC", "HTX"]
THRESHOLD_PCT = 3.0        # |갭| 이 이 값 이상이면 알림
MAX_GAP_PCT = 50.0         # |갭| 이 이 값을 넘으면 티커만 같은 다른 코인으로 보고 무시
POLL_SEC = 10              # 조회 주기(초)
COOLDOWN_SEC = 600         # 같은 거래소·코인 재알림 최소 간격(초)
REALERT_STEP_PCT = 2.0     # 쿨다운 중이라도 갭이 이만큼 더 벌어지면 다시 알림
MIN_SPOT_VOL_USDT = 100_000    # 현물 24h 거래대금 하한 (체결 없는 현물의 가짜 갭 제거)
MIN_PERP_VOL_USDT = 1_000_000  # 선물 24h 거래대금 하한
WATCHLIST = []             # 예: ["TAKE", "BTW"]. 비워두면 현물·선물 동시 상장 전 종목 감시
# ────────────────────────────────────────────────────

TG_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN")
TG_CHAT = os.environ.get("TELEGRAM_CHAT_ID")

# 선물 심볼의 수량 배수 접두사 (예: 1000PEPE, 1MBABYDOGE)
MULT_PREFIX = re.compile(r"^(1000000|100000|10000|1000|1M)(?=[A-Z])")


def get_json(url):
    req = urllib.request.Request(
        url, headers={"Accept": "application/json", "User-Agent": "Mozilla/5.0"}
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def base_of(symbol, suffix):
    """'BTCUSDT' -> 'BTC'. USDT 마켓이 아니면 None."""
    return symbol[: -len(suffix)] if symbol.endswith(suffix) else None


# 거래소별 조회 함수: (현물, 선물) 을 {코인: (최종 체결가, 24h 거래대금 USDT)} 로 돌려준다.

def fetch_binance():
    spot, perp = {}, {}
    for t in get_json("https://api.binance.com/api/v3/ticker/24hr"):
        if b := base_of(t["symbol"], "USDT"):
            spot[b] = (num(t["lastPrice"]), num(t["quoteVolume"]))
    for t in get_json("https://fapi.binance.com/fapi/v1/ticker/24hr"):
        if b := base_of(t["symbol"], "USDT"):  # 만기 선물(BTCUSDT_261225)은 여기서 걸러진다
            perp[b] = (num(t["lastPrice"]), num(t["quoteVolume"]))
    return spot, perp


def fetch_okx():
    spot, perp = {}, {}
    url = "https://www.okx.com/api/v5/market/tickers?instType="
    for t in get_json(url + "SPOT")["data"]:
        if b := base_of(t["instId"], "-USDT"):
            spot[b] = (num(t["last"]), num(t["volCcy24h"]))
    for t in get_json(url + "SWAP")["data"]:
        if b := base_of(t["instId"], "-USDT-SWAP"):
            px = num(t["last"])
            perp[b] = (px, num(t["volCcy24h"]) * px)  # SWAP 의 volCcy24h 는 코인 수량
    return spot, perp


def fetch_bybit():
    spot, perp = {}, {}
    url = "https://api.bybit.com/v5/market/tickers?category="
    for t in get_json(url + "spot")["result"]["list"]:
        if b := base_of(t["symbol"], "USDT"):
            spot[b] = (num(t["lastPrice"]), num(t["turnover24h"]))
    for t in get_json(url + "linear")["result"]["list"]:
        if b := base_of(t["symbol"], "USDT"):
            perp[b] = (num(t["lastPrice"]), num(t["turnover24h"]))
    return spot, perp


def fetch_bitget():
    spot, perp = {}, {}
    for t in get_json("https://api.bitget.com/api/v2/spot/market/tickers")["data"]:
        if b := base_of(t["symbol"], "USDT"):
            spot[b] = (num(t["lastPr"]), num(t["usdtVolume"]))
    url = "https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES"
    for t in get_json(url)["data"]:
        if b := base_of(t["symbol"], "USDT"):
            perp[b] = (num(t["lastPr"]), num(t["usdtVolume"]))
    return spot, perp


def fetch_gate():
    spot, perp = {}, {}
    for t in get_json("https://api.gateio.ws/api/v4/spot/tickers"):
        if b := base_of(t["currency_pair"], "_USDT"):
            spot[b] = (num(t["last"]), num(t["quote_volume"]))
    for t in get_json("https://api.gateio.ws/api/v4/futures/usdt/tickers"):
        if b := base_of(t["contract"], "_USDT"):
            perp[b] = (num(t["last"]), num(t["volume_24h_quote"]))
    return spot, perp


def fetch_kucoin():
    spot, perp = {}, {}
    for t in get_json("https://api.kucoin.com/api/v1/market/allTickers")["data"]["ticker"]:
        if b := base_of(t["symbol"], "-USDT"):
            spot[b] = (num(t["last"]), num(t["volValue"]))
    for t in get_json("https://api-futures.kucoin.com/api/v1/contracts/active")["data"]:
        # FFWCSX = 무기한. 선물 쪽은 비트코인을 XBT 로 표기한다.
        if t["type"] != "FFWCSX" or t["quoteCurrency"] != "USDT" or t["status"] != "Open":
            continue
        b = "BTC" if t["baseCurrency"] == "XBT" else t["baseCurrency"]
        perp[b] = (num(t["lastTradePrice"]), num(t["turnoverOf24h"]))
    return spot, perp


def fetch_mexc():
    spot, perp = {}, {}
    for t in get_json("https://api.mexc.com/api/v3/ticker/24hr"):
        if b := base_of(t["symbol"], "USDT"):
            spot[b] = (num(t["lastPrice"]), num(t["quoteVolume"]))
    for t in get_json("https://contract.mexc.com/api/v1/contract/ticker")["data"]:
        if b := base_of(t["symbol"], "_USDT"):
            perp[b] = (num(t["lastPrice"]), num(t["amount24"]))
    return spot, perp


def fetch_htx():
    spot, perp = {}, {}
    for t in get_json("https://api.huobi.pro/market/tickers")["data"]:
        if b := base_of(t["symbol"].upper(), "USDT"):
            spot[b] = (num(t["close"]), num(t["vol"]))
    url = "https://api.hbdm.com/linear-swap-ex/market/detail/batch_merged"
    for t in get_json(url)["ticks"]:
        if t.get("business_type") == "swap" and (b := base_of(t["contract_code"], "-USDT")):
            perp[b] = (num(t["close"]), num(t["trade_turnover"]))
    return spot, perp


FETCHERS = {
    "Binance": fetch_binance,
    "OKX": fetch_okx,
    "Bybit": fetch_bybit,
    "Bitget": fetch_bitget,
    "Gate": fetch_gate,
    "KuCoin": fetch_kucoin,
    "MEXC": fetch_mexc,
    "HTX": fetch_htx,
}


def calc_gaps(spot, perp):
    gaps = []
    for base, (perp_px, perp_vol) in perp.items():
        coin, mult = base, 1
        if coin not in spot:
            # 선물만 1000PEPE 처럼 배수 단위로 상장된 경우 현물 PEPE 와 맞춘다
            m = MULT_PREFIX.match(base)
            if not m or base[m.end():] not in spot:
                continue
            coin = base[m.end():]
            mult = 1_000_000 if m.group(1) == "1M" else int(m.group(1))
        if WATCHLIST and coin not in WATCHLIST:
            continue
        spot_px, spot_vol = spot[coin]
        perp_px /= mult
        if spot_px <= 0 or perp_px <= 0:
            continue
        if spot_vol < MIN_SPOT_VOL_USDT or perp_vol < MIN_PERP_VOL_USDT:
            continue
        gap = (spot_px - perp_px) / perp_px * 100
        if abs(gap) > MAX_GAP_PCT:
            continue
        gaps.append((coin, gap, spot_px, perp_px))
    return gaps


def fetch_all():
    """{거래소: 갭 목록 또는 예외} 를 돌려준다. 한 거래소가 실패해도 나머지는 계속 본다."""
    def one(name):
        try:
            return name, calc_gaps(*FETCHERS[name]())
        except Exception as e:
            return name, e

    with ThreadPoolExecutor(len(EXCHANGES)) as pool:
        return dict(pool.map(one, EXCHANGES))


def notify(msg):
    print(msg, flush=True)
    try:
        import winsound
        winsound.Beep(1200, 400)
    except Exception:
        pass
    if TG_TOKEN and TG_CHAT:
        data = urllib.parse.urlencode({"chat_id": TG_CHAT, "text": msg}).encode()
        try:
            urllib.request.urlopen(
                f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage", data, timeout=10
            )
        except Exception as e:
            print(f"  (텔레그램 전송 실패: {e})", flush=True)


def print_once(results):
    rows = []
    for ex, res in results.items():
        if isinstance(res, Exception):
            print(f"  {ex:<8} 조회 실패: {res}")
            continue
        print(f"  {ex:<8} 감시 종목 {len(res)}개")
        rows += [(ex, *g) for g in res]
    rows.sort(key=lambda r: -abs(r[2]))
    print("갭 상위 15개:")
    for ex, coin, gap, s, p in rows[:15]:
        print(f"  {ex:<8}{coin:<12}{gap:+7.2f}%  현물 {s:g} / 선물 {p:g}")


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    once = "--once" in sys.argv
    last_alert = {}  # (거래소, 코인) -> (시각, 알림 당시 |갭|)
    failing = set()
    print(
        f"현선갭 감시 시작: {', '.join(EXCHANGES)} / 임계 ±{THRESHOLD_PCT}%, "
        f"{POLL_SEC}초 주기, 텔레그램 {'ON' if TG_TOKEN and TG_CHAT else 'OFF'}",
        flush=True,
    )
    while True:
        results = fetch_all()
        if once:
            print_once(results)
            return

        now = time.time()
        stamp = f"{datetime.now():%H:%M:%S}"
        for ex, res in results.items():
            if isinstance(res, Exception):
                if ex not in failing:  # 실패가 이어지는 동안은 한 번만 찍는다
                    failing.add(ex)
                    print(f"[{stamp}] {ex} 조회 실패: {res}", flush=True)
                continue
            if ex in failing:
                failing.discard(ex)
                print(f"[{stamp}] {ex} 조회 복구", flush=True)
            for coin, gap, s, p in res:
                if abs(gap) < THRESHOLD_PCT:
                    continue
                prev = last_alert.get((ex, coin))
                if prev and now - prev[0] < COOLDOWN_SEC and abs(gap) < prev[1] + REALERT_STEP_PCT:
                    continue
                last_alert[(ex, coin)] = (now, abs(gap))
                side = "현물 > 선물" if gap > 0 else "선물 > 현물"
                notify(
                    f"[{stamp}] {ex} {coin} 현선갭 {gap:+.2f}% ({side})\n"
                    f"  현물 {s:g} / 선물 {p:g}"
                )
        time.sleep(POLL_SEC)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
