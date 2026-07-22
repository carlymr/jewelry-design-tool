import type { Metadata } from "next";
import NavBar from "@/components/NavBar";
import "./globals.css";

export const metadata: Metadata = {
  title: "Jewelry Design Tool",
  description: "Materials inventory and receipt processing for strung jewelry design",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="bg-white text-gray-900 antialiased">
        <NavBar />
        {children}
      </body>
    </html>
  );
}
