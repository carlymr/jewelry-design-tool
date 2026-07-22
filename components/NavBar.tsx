"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Design Board" },
  { href: "/inventory", label: "Inventory" },
];

export default function NavBar() {
  const pathname = usePathname();
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
      </nav>
    </header>
  );
}
