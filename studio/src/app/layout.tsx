import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { TooltipProvider } from "@/components/ui/tooltip";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// follow the OS appearance (light / dark) before first paint, and live afterwards
const THEME = `(()=>{const m=matchMedia("(prefers-color-scheme: dark)");const a=()=>document.documentElement.classList.toggle("dark",m.matches);a();m.addEventListener("change",a)})()`;

export const metadata: Metadata = {
  title: "Netscraper Studio",
  icons: { icon: "/brand/netscraper-mark.svg" },
  description: "Turn any site into a tuned a2flow manifest, then run it anywhere",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME }} />
      </head>
      <body className="h-full overflow-hidden"><TooltipProvider>{children}</TooltipProvider></body>
    </html>
  );
}
