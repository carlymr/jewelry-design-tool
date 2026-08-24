"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogOut } from "lucide-react";
import { useSession } from "@/components/AuthGate";
import { signOut } from "@/lib/auth";

const LINKS = [
  { href: "/", label: "Design Board" },
  { href: "/inventory", label: "Inventory" },
  { href: "/pricing", label: "Pricing & Listing" },
];

export default function NavBar() {
  const pathname = usePathname();
  const session = useSession();
  return (
    <header className="border-b border-gray-200 bg-white">
      <nav className="max-w-6xl mx-auto px-6 flex items-center gap-6 h-12">
        <span className="font-semibold text-purple-700">Jewelry Design Tool</span>
        {LINKS.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className={`text-sm h-full flex items-center border-b-2 ${
              pathname === link.href
                ? "border-purple-600 text-purple-700 font-medium"
                : "border-transparent text-gray-600 hover:text-gray-900"
            }`}
          >
            {link.label}
          </Link>
        ))}
        {session && (
          <span className="ml-auto flex items-center gap-3 text-sm text-gray-500">
            <span className="hidden sm:inline">{session.user.email}</span>
            <button
              onClick={() => signOut()}
              className="p-1.5 text-gray-400 hover:text-gray-700 rounded"
              title="Sign out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </span>
        )}
      </nav>
    </header>
  );
}
