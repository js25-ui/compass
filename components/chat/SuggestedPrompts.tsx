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
      'How is Apple performing this quarter?',
      "What's driving NVIDIA's growth right now?",
      'Compare Tesla and Rivian',
      "What's the latest with Reddit since their IPO?",
    ],
  },
  {
    name: 'Debt Capital Markets',
    tag: 'DCM',
    prompts: [
      "What is Boeing's leverage and debt profile?",
      "How is JPMorgan's credit positioned?",
      'Recent moves in the 10-year Treasury yield',
      'Latest Fed commentary on interest rates',
    ],
  },
  {
    name: 'Alternative Investments',
    tag: 'Alts',
    prompts: [
      "What is Blackstone's strategy in 2026?",
      "KKR's recent capital deployment activity",
      "What's happening with Stripe lately?",
      "What is OpenAI doing this year?",
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
