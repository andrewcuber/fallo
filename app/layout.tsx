import type { Metadata } from "next";
import { Inter, Lora } from "next/font/google";
import "./globals.css";
import { FieldProvider } from "@/components/providers";
import { AppShell } from "@/components/app-shell";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const lora = Lora({
  subsets: ["latin"],
  variable: "--font-lora",
  display: "swap",
});

export const metadata: Metadata = {
  title: "fallo — Understand your land. Explore its future.",
  description:
    "A decision-support tool for farmers to explore crop rotation strategies using climate and soil data.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} ${lora.variable}`} suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans antialiased">
        <FieldProvider>
          <AppShell>{children}</AppShell>
        </FieldProvider>
      </body>
    </html>
  );
}
