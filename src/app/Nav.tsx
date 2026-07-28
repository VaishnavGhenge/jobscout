"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Board" },
  { href: "/tracker", label: "Tracker" },
  { href: "/insights", label: "Insights" },
];

/** Nav that marks the page you're on — needs the pathname, so it's a client bit. */
export function Nav() {
  const pathname = usePathname();
  return (
    <nav>
      {LINKS.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          aria-current={pathname === l.href ? "page" : undefined}
        >
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
