import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI 综合工作台",
  description: "面向内容增长与经营决策的一体化 AI 工作台。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
