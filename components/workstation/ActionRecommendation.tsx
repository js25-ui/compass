import type { ActionData } from '@/lib/demo-data';

interface ActionRecommendationProps {
  data: ActionData;
}

export function ActionRecommendation({ data }: ActionRecommendationProps) {
  return (
    <div className="stage-content">
      <div className="stage-intro">
        <h3>Action Recommendation</h3>
        <p>Synthesized recommendation with conviction level and key thesis points.</p>
      </div>
      <div className="reco-banner">
        <h3>Final Recommendation</h3>
        <div className={`reco-action ${data.actionClass}`}>{data.action}</div>
        <div className="reco-summary">{data.summary}</div>
      </div>
      <div className="reco-grid">
        <div className="data-card">
          <h3>Key Thesis Points</h3>
          <ul className="reco-thesis-list">
            {data.thesis.map((t, i) => (
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
              {data.targets.map(t => (
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
