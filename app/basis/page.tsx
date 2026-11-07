import type { Metadata } from "next";
import BasisScreen from "@/components/basis/BasisScreen";

const title = "BASIS GAP | 거래소별 현선갭 감시";
const description =
  "8개 거래소에서 같은 거래소의 USDT 현물과 무기한 선물 가격 차이를 10초마다 비교하고, 기준을 넘으면 소리 크기를 조절할 수 있는 알림을 냅니다.";

export const metadata: Metadata = {
  title,
  description,
  openGraph: { type: "website", locale: "ko_KR", siteName: "CRYPTO FLOW", title, description },
};

export default function BasisPage() {
  return <BasisScreen />;
}
