import { actionByBL, type BusinessLine } from '@/lib/demo-data';

interface ActionRecommendationProps {
  bl: BusinessLine;
}

export function ActionRecommendation({ bl }: ActionRecommendationProps) {
  const a = actionByBL[bl];
  return (
    <div className="stage-content">
      <div className="stage-intro">
        <h3>Action Recommendation</h3>
        <p>Synthesized recommendation with conviction level and key thesis points.</p>
      </div>
      <div className="reco-banner">
        <h3>Final Recommendation</h3>
        <div className={`reco-action ${a.actionClass}`}>{a.action}</div>
        <div className="reco-summary">{a.summary}</div>
      </div>
      <div className="reco-grid">
        <div className="data-card">
          <h3>Key Thesis Points</h3>
          <ul className="reco-thesis-list">
            {a.thesis.map((t, i) => (
              <li key={t} className="reco-thesis-item">
                <div className="thesis-num">{i + 1}</div>
                <div className="thesis-text">{t}</div>
              </li>
            ))}
          </ul>
        </div>
        <div className="data-card">
          <h3>Target Outcomes</h3>
          <table className="reco-table">
            <tbody>
              {a.targets.map(t => (
                <tr key={t.label}>
                  <td className="rt-label">{t.label}</td>
                  <td className="rt-value">{t.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
