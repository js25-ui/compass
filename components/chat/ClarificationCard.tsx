'use client';

import { useMemo, useState } from 'react';
import type { ClarifyQuestion } from '@/lib/agents/clarify';

export interface ClarificationPayload {
  taskType: string;
  assetClass: string;
  detectedTarget: { name: string; ticker?: string } | null;
  preface: string;
  questions: ClarifyQuestion[];
}

interface ClarificationCardProps {
  payload: ClarificationPayload;
  disabled?: boolean;
  onSubmit: (answers: Record<string, string | number | boolean | string[]>) => void;
}

type AnswerValue = string | number | boolean | string[];

function defaultFor(q: ClarifyQuestion): AnswerValue {
  if (q.default !== undefined) {
    if (q.kind === 'multi_select' && !Array.isArray(q.default)) {
      return [String(q.default)];
    }
    return q.default;
  }
  if (q.kind === 'multi_select') return [];
  if (q.kind === 'numeric') return 0;
  if (q.kind === 'boolean') return false;
  if (q.kind === 'select' && q.options?.[0]) return q.options[0].value;
  return '';
}

export function ClarificationCard({ payload, disabled, onSubmit }: ClarificationCardProps) {
  const initial = useMemo(() => {
    const out: Record<string, AnswerValue> = {};
    for (const q of payload.questions) out[q.id] = defaultFor(q);
    return out;
  }, [payload.questions]);

  const [answers, setAnswers] = useState<Record<string, AnswerValue>>(initial);

  const setAnswer = (id: string, v: AnswerValue) => setAnswers(prev => ({ ...prev, [id]: v }));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled) return;
    onSubmit(answers);
  };

  return (
    <div className="clarify-card">
      <div className="clarify-header">
        <span className="clarify-tag">Scope</span>
        <span className="clarify-task">
          {payload.taskType.replace(/_/g, ' ')}
          {payload.detectedTarget?.name ? ` · ${payload.detectedTarget.name}` : ''}
          {payload.detectedTarget?.ticker ? ` (${payload.detectedTarget.ticker})` : ''}
        </span>
      </div>

      {payload.preface ? <p className="clarify-preface">{payload.preface}</p> : null}

      <form className="clarify-form" onSubmit={handleSubmit}>
        {payload.questions.map(q => (
          <div key={q.id} className="clarify-question">
            <label className="clarify-question-prompt" htmlFor={`q-${q.id}`}>
              {q.prompt}
            </label>
            <QuestionInput
              question={q}
              value={answers[q.id]}
              onChange={v => setAnswer(q.id, v)}
              disabled={disabled}
            />
          </div>
        ))}
        <div className="clarify-actions">
          <button type="submit" className="clarify-submit" disabled={disabled}>
            {disabled ? 'Working…' : 'Run with these inputs →'}
          </button>
        </div>
      </form>
    </div>
  );
}

interface QuestionInputProps {
  question: ClarifyQuestion;
  value: AnswerValue;
  onChange: (v: AnswerValue) => void;
  disabled?: boolean;
}

function QuestionInput({ question: q, value, onChange, disabled }: QuestionInputProps) {
  const id = `q-${q.id}`;

  if (q.kind === 'select') {
    return (
      <select
        id={id}
        className="clarify-select"
        value={String(value)}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
      >
        {q.options?.map(opt => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    );
  }

  if (q.kind === 'multi_select') {
    const arr = Array.isArray(value) ? value : [];
    const toggle = (v: string) => {
      const next = arr.includes(v) ? arr.filter(x => x !== v) : [...arr, v];
      onChange(next);
    };
    return (
      <div className="clarify-chips">
        {q.options?.map(opt => {
          const active = arr.includes(opt.value);
          return (
            <button
              key={opt.value}
              type="button"
              className={`clarify-chip${active ? ' active' : ''}`}
              onClick={() => toggle(opt.value)}
              disabled={disabled}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    );
  }

  if (q.kind === 'numeric') {
    return (
      <div className="clarify-numeric">
        <input
          id={id}
          type="number"
          className="clarify-input"
          value={typeof value === 'number' ? value : Number(value) || 0}
          onChange={e => onChange(Number(e.target.value))}
          disabled={disabled}
        />
        {q.unit ? <span className="clarify-unit">{q.unit}</span> : null}
      </div>
    );
  }

  if (q.kind === 'boolean') {
    return (
      <div className="clarify-chips">
        <button type="button" className={`clarify-chip${value === true ? ' active' : ''}`} onClick={() => onChange(true)} disabled={disabled}>
          Yes
        </button>
        <button type="button" className={`clarify-chip${value === false ? ' active' : ''}`} onClick={() => onChange(false)} disabled={disabled}>
          No
        </button>
      </div>
    );
  }

  return (
    <input
      id={id}
      type="text"
      className="clarify-input"
      value={String(value ?? '')}
      onChange={e => onChange(e.target.value)}
      disabled={disabled}
      placeholder={q.unit ?? ''}
    />
  );
}
