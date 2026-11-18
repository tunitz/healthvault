import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/theme-provider";
import { AppNav } from "@/components/app-nav";
import { SwRegister } from "@/components/sw-register";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "Health Vault", template: "%s · Health Vault" },
  description: "Apple Health export explorer",
  // Personal health data on a LAN-bound single-user app: never index it.
  robots: { index: false, follow: false },
  appleWebApp: { capable: true, title: "Health Vault", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f8fa" },
    { media: "(prefers-color-scheme: dark)", color: "#16181c" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-background text-foreground">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-[calc(env(safe-area-inset-top)+0.75rem)] focus:start-4 focus:z-50 focus:rounded-md focus:border focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:shadow-lg"
        >
          Skip to content
        </a>
        <ThemeProvider>
          {/* AppNav owns the header, grouped sidebar and mobile bar so the collapse state can
              drive the content width directly. On /login it renders children without chrome. */}
          <AppNav>
            <main
              id="main"
              tabIndex={-1}
              className="min-w-0 flex-1 scroll-mt-[calc(3.5rem+env(safe-area-inset-top))] px-4 py-6 pb-[calc(7rem+env(safe-area-inset-bottom))] outline-none sm:px-6 md:pb-10 lg:px-8"
            >
              {children}
            </main>
          </AppNav>
          <SwRegister />
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
