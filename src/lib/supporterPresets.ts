import type { FilterAnyOfRule } from './types';

/** Organizer-style OR rules for Supporter tags (from campaign communities). */
export type SupporterTagPreset = {
  name: string;
  description: string;
  supporter_tag: string;
  tag_priority: number;
  any_of: FilterAnyOfRule[];
};

export const SUPPORT_SCORE_LABELS: Record<number, string> = {
  1: '1 — Strong Support',
  2: '2 — Support',
  3: '3 — Undecided',
  4: '4 — Oppose',
  5: '5 — Strong Oppose',
};

/** Achilles Vote (supporters) — OR across these conditions. */
export const PRESET_SUPPORTER: SupporterTagPreset = {
  name: 'Achilles Vote',
  description: 'Pretty confident we have their votes',
  supporter_tag: 'supporter',
  tag_priority: 30,
  any_of: [
    { field: 'yard_sign', values: ['Yes', 'Delivered'] },
    { field: 'donated', values: ['Yes'] },
    { field: 'alignment_label', values: ['Positive'] },
    { field: 'support_score', values: [1, 2] },
    { field: 'convos_candidate_support', values: ['yes'] },
    { field: 'volunteer_interest', values: ['Yes'] },
    { field: 'attended_event', values: ['Yes'] },
    { field: 'newsletter', values: ['Yes'] },
  ],
};

/** Oppose Achilles */
export const PRESET_OPPOSED: SupporterTagPreset = {
  name: 'Oppose Achilles',
  description: 'Opposed / negative support signals',
  supporter_tag: 'opposed',
  tag_priority: 20,
  any_of: [
    { field: 'convos_candidate_support', values: ['no'] },
    { field: 'alignment_label', values: ['Negative'] },
    { field: 'support_score', values: [4, 5] },
  ],
};

/** Maybes / undecided */
export const PRESET_MAYBE: SupporterTagPreset = {
  name: 'Maybe',
  description: 'Neutral / undecided signals',
  supporter_tag: 'maybe',
  tag_priority: 10,
  any_of: [
    { field: 'alignment_label', values: ['Neutral'] },
    { field: 'convos_candidate_support', values: ['maybe'] },
    { field: 'convos_poll_question', values: ['C) Not Sure'] },
    { field: 'support_score', values: [3] },
  ],
};

export const SUPPORTER_TAG_PRESETS: SupporterTagPreset[] = [
  PRESET_SUPPORTER,
  PRESET_OPPOSED,
  PRESET_MAYBE,
];

export function summarizeAnyOfRule(rule: FilterAnyOfRule): string {
  if (rule.field === 'support_score') {
    const nums = (rule.values as number[]).map(
      (n) => SUPPORT_SCORE_LABELS[n] ?? String(n),
    );
    return `Support score is ${nums.join(' or ')}`;
  }
  const vals = (rule.values as string[]).join(' or ');
  const labels: Record<string, string> = {
    yard_sign: 'Yard sign',
    donated: 'Donated',
    alignment_label: 'Alignment label',
    convos_candidate_support: 'Convos — candidate support',
    convos_poll_question: 'Convos — poll question',
    convos_contact_status: 'Convos — contact status',
    volunteer_interest: 'Volunteer interest',
    newsletter: 'Newsletter',
    attended_event: 'Attended event',
    top_main_topic: 'Top topic',
  };
  return `${labels[rule.field] ?? rule.field} is ${vals}`;
}
