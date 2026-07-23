import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { NavBar } from "./components/NavBar";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "OpenMW Analytics",
  description: "Telemetry dashboard for OpenMW mods",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      {/*
        `children` is what Angular's <router-outlet> does, but as a PROP rather than a directive:
        Next passes the matched page in, and this file wraps it. A layout does not re-render when
        you navigate between the pages inside it -- so the NavBar below is mounted once and keeps
        its state across navigations.

        Note this file has no 'use client' -- it is a SERVER Component rendering a CLIENT
        Component (NavBar). That direction is always allowed: the server renders the tree and
        marks the client parts for hydration in the browser. The reverse -- importing a Server
        Component into a Client Component -- is not, because by then we are already in the browser.
      */}
      <body className="min-h-full flex flex-col">
        <NavBar />
        {children}
      </body>
    </html>
  );
}
