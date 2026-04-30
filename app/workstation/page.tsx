'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { demoTargets, type BusinessLine } from '@/lib/demo-data';

interface BLConfig {
  id: BusinessLine;
  num: string;
  name: string;
  fullname: string;
  desc: string;
  tags: string[];
}

const blConfigs: BLConfig[] = [
  {
    id: 'ecm',
    num: '01',
    name: 'ECM',
    fullname: 'Equity Capital Markets',
    desc: 'Origination and execution across IPOs, follow-ons, secondaries, convertibles, and equity-linked products.',
    tags: ['IPOs', 'Follow-Ons', 'Convertibles'],
  },
  {
    id: 'dcm',
    num: '02',
    name: 'DCM',
    fullname: 'Debt Capital Markets',
    desc: 'Origination and analytics across IG corporate, high yield, leveraged loans, municipals, sovereigns, and securitized products.',
    tags: ['IG Corp', 'HY', 'Muni', 'Sovereign'],
  },
  {
    id: 'alts',
    num: '03',
    name: 'Alternatives',
    fullname: 'Alternative Investments',
    desc: 'Private markets and hedge funds. Sponsor-side modeling, Monte Carlo return analysis, and AI-disruption risk scoring.',
    tags: ['Private Equity', 'Real Estate', 'Credit', 'Infra'],
  },
];

const quickTries: Array<{ label: string; bl: BusinessLine; targetId: string }> = [
  { label: 'Cava Group IPO', bl: 'ecm', targetId: 'cava-ipo-2026' },
  { label: 'Boeing 30Y Notes', bl: 'dcm', targetId: 'ba-30y-2056' },
  { label: 'NYC GO Bonds', bl: 'dcm', targetId: 'nyc-go-2026' },
  { label: 'Blackstone', bl: 'alts', targetId: 'blackstone-pe-2026' },
];

export default function WorkstationLandingPage() {
  const router = useRouter();
  const [search, setSearch] = useState('');

  const goToBL = (bl: BusinessLine) => {
    const target = demoTargets.find(t => t.bl === bl);
    if (target) router.push(`/workstation/${bl}/${target.id}`);
  };

  const goToTarget = (bl: BusinessLine, targetId: string) => {
    router.push(`/workstation/${bl}/${targetId}`);
  };

  return (
    <div className="landing-workstation">
      <div className="hero">
        <div className="hero-eyebrow">Workstation · Manual Exploration</div>
        <h1 className="hero-title">Six-stage analyst lifecycle across capital markets and alternatives.</h1>
        <p className="hero-sub">
          Choose a business line to explore deals, run models with Monte Carlo simulation, draft memos,
          and synthesize action recommendations. For conversational queries with cited answers, switch
          to Ask Compass.
        </p>
        <div className="stages-row">
          <div className="stage-chip">01 Research</div>
          <div className="stage-chip">02 Diligence</div>
          <div className="stage-chip">03 Model</div>
          <div className="stage-chip">04 Memo</div>
          <div className="stage-chip">05 Monitor</div>
          <div className="stage-chip">06 Action</div>
        </div>
      </div>

      <div className="search-section">
        <div className="search-bar">
          <input
            type="text"
            className="search-input"
            placeholder="Type a company, ticker, deal, or thesis..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') goToTarget('ecm', 'cava-ipo-2026');
            }}
          />
          <button className="search-btn" onClick={() => goToTarget('ecm', 'cava-ipo-2026')}>
            Run Research
          </button>
        </div>
        <div className="search-hint">
          <span>Try:</span>
          {quickTries.map(q => (
            <span key={q.label} onClick={() => goToTarget(q.bl, q.targetId)}>{q.label}</span>
          ))}
        </div>
      </div>

      <div className="verticals-label">Choose a business line</div>
      <div className="business-lines">
        {blConfigs.map(bl => (
          <button key={bl.id} className="bl-tile" onClick={() => goToBL(bl.id)}>
            <div className="bl-num">{bl.num}</div>
            <div className="bl-name">{bl.name}</div>
            <div className="bl-fullname">{bl.fullname}</div>
            <div className="bl-desc">{bl.desc}</div>
            <div className="bl-tags">
              {bl.tags.map(t => (
                <span key={t} className="bl-tag-mini">{t}</span>
              ))}
            </div>
            <div className="bl-arrow">→</div>
          </button>
        ))}
      </div>
    </div>
  );
}
