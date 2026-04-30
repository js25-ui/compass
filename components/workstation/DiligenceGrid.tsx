import type { DiligenceItem } from '@/lib/demo-data';

interface DiligenceGridProps {
  items: DiligenceItem[];
}

export function DiligenceGrid({ items }: DiligenceGridProps) {
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
