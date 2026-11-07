import Link from "next/link";
import styles from "./SectionSwitcher.module.css";

export type FlowSection = "binance" | "upbit" | "kimp" | "basis";

export const FLOW_SECTIONS: readonly {
  id: FlowSection;
  href: string;
  label: string;
  caption: string;
}[] = [
  { id: "binance", href: "/binance", label: "BINANCE", caption: "바이낸스 USDT 무기한 선물 12분할 차트" },
  { id: "upbit", href: "/upbit", label: "UPBIT", caption: "업비트 KRW 현물 12분할 차트" },
  { id: "kimp", href: "/kimp", label: "김프", caption: "업비트 대 해외 현물 갭 차트" },
  { id: "basis", href: "/basis", label: "현선갭", caption: "거래소별 현물·선물 갭 감시와 알림" },
];

/** 네 화면을 오가는 전환 메뉴. 각 화면의 상단 오른쪽에 들어가며, 그 화면의 테마 색을 그대로 씁니다. */
export default function SectionSwitcher({ current }: { current: FlowSection }) {
  return (
    <nav className={styles.switcher} aria-label="CRYPTO FLOW 화면 전환">
      {FLOW_SECTIONS.map((section) => (
        <Link
          key={section.id}
          href={section.href}
          className={styles.item}
          data-section={section.id}
          aria-current={section.id === current ? "page" : undefined}
          title={section.caption}
        >
          <i aria-hidden="true" />
          <span>{section.label}</span>
        </Link>
      ))}
    </nav>
  );
}
