'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function TopNav() {
  const pathname = usePathname();
  const isWorkstation = pathname.startsWith('/workstation');
  const isAsk = !isWorkstation;

  return (
    <div className="topbar">
      <div className="topbar-left">
        <Link href="/ask" className="logo">
          <div className="logo-mark" />
          <div className="logo-text">COMPASS</div>
        </Link>
        <nav className="global-nav">
          <Link href="/workstation" className={`global-tab${isWorkstation ? ' active' : ''}`}>
            <span className="global-tab-icon">▦</span>
            <span>Workstation</span>
          </Link>
          <Link href="/ask" className={`global-tab${isAsk ? ' active' : ''}`}>
            <span className="global-tab-icon">✦</span>
            <span>Ask Compass</span>
            <span className="ask-badge">RAG</span>
          </Link>
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
