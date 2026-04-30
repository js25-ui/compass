'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { businessLineNames, demoTargets, recentResearch, type BusinessLine } from '@/lib/demo-data';

interface SidebarProps {
  currentBL: BusinessLine;
}

export function Sidebar({ currentBL }: SidebarProps) {
  const router = useRouter();

  const goBL = (bl: BusinessLine) => {
    const target = demoTargets.find(t => t.bl === bl);
    if (target) router.push(`/workstation/${bl}/${target.id}`);
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-section">
        <div className="sidebar-label">Business Lines</div>
        <ul className="vertical-list">
          {(Object.keys(businessLineNames) as BusinessLine[]).map(bl => (
            <li
              key={bl}
              className={`vertical-item${bl === currentBL ? ' active' : ''}`}
              onClick={() => goBL(bl)}
            >
              {businessLineNames[bl]}
            </li>
          ))}
        </ul>
      </div>

      <div className="sidebar-section">
        <div className="sidebar-label">Recent Research</div>
        {recentResearch.map(r => (
          <Link
            key={r.targetId}
            href={`/workstation/${r.bl}/${r.targetId}`}
            className="recent-item"
            style={{ display: 'block', textDecoration: 'none' }}
          >
            <span className="recent-ticker">{r.ticker}</span>
            {r.title}
          </Link>
        ))}
      </div>

      <div className="sidebar-section">
        <Link href="/workstation" className="back-btn" style={{ textDecoration: 'none' }}>
          ← New Research
        </Link>
      </div>
    </aside>
  );
}
