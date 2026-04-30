'use client';

import { useState } from 'react';
import { mcByBL, modelTabsByBL, type BusinessLine } from '@/lib/demo-data';
import { MonteCarloChart } from './MonteCarloChart';

interface ModelStageProps {
  bl: BusinessLine;
}

export function ModelStage({ bl }: ModelStageProps) {
  const tabs = modelTabsByBL[bl];
  const [activeTab, setActiveTab] = useState<string>('Monte Carlo');
  const cfg = mcByBL[bl];

  return (
    <div className="stage-content">
      <div className="stage-intro">
        <h3>Model</h3>
        <p>Asset-class-appropriate model auto-built from filings and diligence. Run Monte Carlo simulation to quantify outcome distribution.</p>
      </div>
      <div className="model-tabs">
        {tabs.map(t => (
          <button
            key={t}
            className={`model-tab${t === activeTab ? ' active' : ''}`}
            onClick={() => setActiveTab(t)}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="mc-banner">
        <div>
          <span className="mc-status">● Simulation Complete</span>
          &nbsp;
          <span className="mc-meta">10,000 trials · 6 stochastic inputs · Seed 42</span>
        </div>
        <div className="mc-meta">Last run: 2 minutes ago</div>
      </div>

      <div className="mc-prob-grid">
        {cfg.probs.map(p => (
          <div key={p.label} className="prob-card">
            <div className={`prob-pct ${p.cls}`}>{p.val}</div>
            <div className="prob-label">{p.label}</div>
          </div>
        ))}
      </div>

      <div className="mc-grid">
        <div className="mc-chart-card">
          <h4>{cfg.chartTitle}</h4>
          <div className="mc-chart-wrap">
            <MonteCarloChart bl={bl} config={cfg} />
          </div>
        </div>
        <div className="mc-side-card">
          <h4>{cfg.pctTitle}</h4>
          <table className="pct-table">
            <tbody>
              {cfg.pcts.map(p => (
                <tr key={p.l}>
                  <td className="pct-label">{p.l}</td>
                  <td className={`pct-value${p.cls ? ' ' + p.cls : ''}`}>{p.v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
