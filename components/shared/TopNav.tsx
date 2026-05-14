'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS: Array<{ href: string; label: string; icon: string }> = [
  { href: '/chat', label: 'Chat', icon: '✦' },
  { href: '/work', label: 'Work', icon: '◫' },
  { href: '/library', label: 'Library', icon: '▤' },
];

export function TopNav() {
  const pathname = usePathname();
  return (
    <div className="topbar">
      <div className="topbar-left">
        <Link href="/chat" className="logo">
          <div className="logo-mark" />
          <div className="logo-text">COMPASS</div>
        </Link>
        <nav className="global-nav">
          {TABS.map(t => {
            const active = pathname === t.href || pathname.startsWith(t.href + '/');
            return (
              <Link key={t.href} href={t.href} className={`global-tab${active ? ' active' : ''}`}>
                <span className="global-tab-icon">{t.icon}</span>
                <span>{t.label}</span>
              </Link>
            );
          })}
        </nav>
      </div>
      <div className="topbar-right">
        <span>
          <span className="status-dot" />
          Live data
        </span>
      </div>
    </div>
  );
}
