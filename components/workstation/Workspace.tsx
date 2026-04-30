'use client';

import { useState } from 'react';
import { Sidebar } from '@/components/shared/Sidebar';
import { TargetHeader } from '@/components/shared/TargetHeader';
import { ResearchFeed } from './ResearchFeed';
import { DiligenceGrid } from './DiligenceGrid';
import { ModelStage } from './ModelStage';
import { MemoDoc } from './MemoDoc';
import { MonitorPanel } from './MonitorPanel';
import { ActionRecommendation } from './ActionRecommendation';
import {
  subtagsByBL,
  type ActionData,
  type BusinessLine,
  type DiligenceItem,
  type FeedItem,
  type Memo,
  type Metric,
  type MonitorData,
  type MonteCarloConfig,
  type Stage,
} from '@/lib/demo-data';

interface WorkspaceProps {
  bl: BusinessLine;
  title: string;
  feed: FeedItem[];
  metrics: Metric[];
  quickQs: string[];
  diligence: DiligenceItem[];
  monteCarlo: MonteCarloConfig;
  memo: Memo;
  monitor: MonitorData;
  action: ActionData;
}

const stages: Array<{ id: Stage; label: string; num: string }> = [
  { id: 'research', label: 'Research', num: '01' },
  { id: 'diligence', label: 'Diligence', num: '02' },
  { id: 'model', label: 'Model', num: '03' },
  { id: 'memo', label: 'Memo', num: '04' },
  { id: 'monitor', label: 'Monitor', num: '05' },
  { id: 'action', label: 'Action', num: '06' },
];

export function Workspace(props: WorkspaceProps) {
  const { bl, title, feed, metrics, quickQs, diligence, monteCarlo, memo, monitor, action } = props;
  const [stage, setStage] = useState<Stage>('research');
  const [subtag, setSubtag] = useState<string>(subtagsByBL[bl][0].id);

  return (
    <div className="page">
      <Sidebar currentBL={bl} />
      <div className="main-area">
        <TargetHeader bl={bl} title={title} />

        <div className="stage-bar">
          {stages.map(s => (
            <button
              key={s.id}
              className={`stage-tab${s.id === stage ? ' active' : ''}`}
              onClick={() => setStage(s.id)}
            >
              <span className="stage-num">{s.num}</span> {s.label}
            </button>
          ))}
        </div>

        {stage === 'research' && (
          <ResearchFeed
            bl={bl}
            feed={feed}
            metrics={metrics}
            quickQs={quickQs}
            activeSubtag={subtag}
            onSubtagChange={setSubtag}
          />
        )}
        {stage === 'diligence' && <DiligenceGrid items={diligence} />}
        {stage === 'model' && <ModelStage bl={bl} config={monteCarlo} />}
        {stage === 'memo' && <MemoDoc memo={memo} />}
        {stage === 'monitor' && <MonitorPanel data={monitor} />}
        {stage === 'action' && <ActionRecommendation data={action} />}
      </div>
    </div>
  );
}
