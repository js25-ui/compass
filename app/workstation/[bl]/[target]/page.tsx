'use client';

import { notFound, useParams } from 'next/navigation';
import { useState } from 'react';
import { Sidebar } from '@/components/shared/Sidebar';
import { TargetHeader } from '@/components/shared/TargetHeader';
import { ResearchFeed } from '@/components/workstation/ResearchFeed';
import { DiligenceGrid } from '@/components/workstation/DiligenceGrid';
import { ModelStage } from '@/components/workstation/ModelStage';
import { MemoDoc } from '@/components/workstation/MemoDoc';
import { MonitorPanel } from '@/components/workstation/MonitorPanel';
import { ActionRecommendation } from '@/components/workstation/ActionRecommendation';
import {
  businessLineNames,
  getTarget,
  subtagsByBL,
  type BusinessLine,
  type Stage,
} from '@/lib/demo-data';

const stages: Array<{ id: Stage; label: string; num: string }> = [
  { id: 'research', label: 'Research', num: '01' },
  { id: 'diligence', label: 'Diligence', num: '02' },
  { id: 'model', label: 'Model', num: '03' },
  { id: 'memo', label: 'Memo', num: '04' },
  { id: 'monitor', label: 'Monitor', num: '05' },
  { id: 'action', label: 'Action', num: '06' },
];

function isBusinessLine(value: string): value is BusinessLine {
  return value in businessLineNames;
}

export default function WorkspacePage() {
  const params = useParams<{ bl: string; target: string }>();
  const blParam = params.bl;
  const targetId = params.target;

  if (!isBusinessLine(blParam)) notFound();
  const bl: BusinessLine = blParam;

  const target = getTarget(targetId);
  if (!target || target.bl !== bl) notFound();

  const [stage, setStage] = useState<Stage>('research');
  const [subtag, setSubtag] = useState<string>(subtagsByBL[bl][0].id);

  return (
    <div className="page">
      <Sidebar currentBL={bl} />
      <div className="main-area">
        <TargetHeader bl={bl} title={target.title} />

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
          <ResearchFeed bl={bl} activeSubtag={subtag} onSubtagChange={setSubtag} />
        )}
        {stage === 'diligence' && <DiligenceGrid bl={bl} />}
        {stage === 'model' && <ModelStage bl={bl} />}
        {stage === 'memo' && <MemoDoc bl={bl} />}
        {stage === 'monitor' && <MonitorPanel bl={bl} />}
        {stage === 'action' && <ActionRecommendation bl={bl} />}
      </div>
    </div>
  );
}
