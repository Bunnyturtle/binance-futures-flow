import { redirect } from "next/navigation";

/** 첫 화면은 바이낸스 선물 차트입니다. 다른 화면은 상단 전환 메뉴로 오갑니다. */
export default function Home() {
  redirect("/binance");
}
