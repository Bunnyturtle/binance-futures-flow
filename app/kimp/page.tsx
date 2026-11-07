import type { Metadata } from "next";
import KimpScreen from "@/components/kimp/KimpScreen";

const title = "KIMCHI GAP | 업비트 vs 해외 현물 갭";
const description =
  "업비트 KRW 가격을 KRW-USDT로 환산해 바이낸스·바이빗·비트겟·게이트·OKX USDT 현물과 비교하는 실시간 김프 차트입니다.";

export const metadata: Metadata = {
  title,
  description,
  openGraph: { type: "website", locale: "ko_KR", siteName: "CRYPTO FLOW", title, description },
};

export default function KimpPage() {
  return <KimpScreen />;
}
