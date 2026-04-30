import { dilByBL, type BusinessLine } from '@/lib/demo-data';

interface DiligenceGridProps {
  bl: BusinessLine;
}

export function DiligenceGrid({ bl }: DiligenceGridProps) {
  const items = dilByBL[bl];
  return (
    <div className="stage-content">
      <div className="stage-intro">
        <h3>Diligence</h3>
        <p>Structured extraction across the data room and disclosure package.</p>
      </div>
      <div className="dil-grid">
        {items.map(d => {
          const flagLabel = d.flag === 'green' ? 'Strong' : d.flag === 'yellow' ? 'Yellow Flag' : 'Red Flag';
          return (
            <div key={d.title} className="dil-card">
              <h4>{d.title}</h4>
              <div className="big-stat">{d.val}</div>
              <div className="stat-sub">{d.sub}</div>
              <span className={`dil-flag ${d.flag}`}>{flagLabel}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
