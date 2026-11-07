import type { Metadata } from "next";
import { UpbitDashboard } from "@/components/upbit/UpbitDashboard";

const title = "UPBIT FLOW | 업비트 KRW 실시간 12분할 차트";
const description =
  "업비트 KRW 마켓을 12개 슬롯에서 감시하는 실시간 다중 차트입니다. C1·C2는 사용자가 지정한 종목을 유지하고 C3~C12는 24시간 거래대금 상위 10종목으로 1시간마다 자동 배열합니다. RADAR 탭은 거래대금 규모·최근 거래대금 강도·전일 대비 가격을 5:3:2로 평가한 관심 후보를 보여 줍니다.";

export const metadata: Metadata = {
  title,
  description,
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
  openGraph: {
    type: "website",
    locale: "ko_KR",
    siteName: "UPBIT FLOW",
    title,
    description,
  },
  twitter: { card: "summary_large_image", title, description },
};

export default function UpbitPage() {
  return <UpbitDashboard />;
}
