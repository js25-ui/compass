'use client';

import { useRouter } from 'next/navigation';

interface Category {
  name: string;
  tag: string;
  prompts: string[];
}

const categories: Category[] = [
  {
    name: 'Equity Capital Markets',
    tag: 'ECM',
    prompts: [
      'Should we price Cava IPO at $22 or the midpoint?',
      'Compare Klaviyo to other 2026 SaaS IPOs',
      'Run Day-1 aftermarket Monte Carlo on Cava',
      'Build dilution model for the Carvana follow-on',
    ],
  },
  {
    name: 'Debt Capital Markets',
    tag: 'DCM',
    prompts: [
      'Where should Boeing 30Y senior notes price?',
      'Compare NYC GO Bonds to recent AA muni issuance',
      'What does the FOMC decision mean for IG spreads?',
      'Pull all 30Y industrial bond comps from last 90 days',
    ],
  },
  {
    name: 'Alternative Investments',
    tag: 'Alts',
    prompts: [
      "What is Blackstone's AI strategy in 2026?",
      'Generate AI-disruption risk memo for vertical SaaS LBO',
      'Compare KKR vs Apollo Q1 deployment',
      'Run LBO with Monte Carlo on $1.3B target',
    ],
  },
];

export function SuggestedPrompts() {
  const router = useRouter();

  const send = (prompt: string) => {
    router.push(`/ask/conversation?q=${encodeURIComponent(prompt)}`);
  };

  return (
    <div className="suggested-prompts-section">
      <div className="suggested-prompts-label">— Try a prompt to get started —</div>
      <div className="suggested-prompts-grid">
        {categories.map(cat => (
          <div key={cat.tag} className="prompt-category">
            <div className="prompt-category-header">
              <span className="prompt-category-name">{cat.name}</span>
              <span className="prompt-category-tag">{cat.tag}</span>
            </div>
            <div className="prompt-list">
              {cat.prompts.map(p => (
                <button key={p} className="prompt-item" onClick={() => send(p)}>
                  {p}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
