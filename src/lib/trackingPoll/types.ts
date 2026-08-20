import type { PollAnswer } from './answers';
import type { MovementKind } from './movement';

export type MatchMethod = 'profile_id' | 'phone' | 'email' | 'manual' | 'unmatched';
export type MatchStatus = 'matched' | 'unmatched' | 'conflict';

export type TrackingPoll = {
  id: number;
  poll_date: string;
  label: string | null;
  created_at: string;
};

export type TrackingPollImport = {
  id: string;
  poll_id: number;
  filename: string | null;
  file_hash: string | null;
  imported_at: string;
  imported_by: string | null;
  row_count: number;
  ready_count: number;
  matched_count: number;
  unmatched_count: number;
  duplicate_count: number;
  conflict_count: number;
  invalid_count: number;
  imported_count: number;
};

export type TrackingPollResponse = {
  id: number;
  poll_id: number;
  poll_date: string;
  import_id: string | null;
  voter_id: number | null;
  person_key: string;
  match_method: MatchMethod;
  match_status: MatchStatus;
  source_profile_id: string | null;
  source_phone: string | null;
  source_email: string | null;
  source_name: string | null;
  raw_answer: string | null;
  normalized_answer: PollAnswer;
  answered_at: string | null;
  display_name: string | null;
  display_phone: string | null;
  display_email: string | null;
  profile_id: string | null;
  party: string | null;
  gender: string | null;
};

export type ParsedPollRow = {
  uid: string;
  source_name: string | null;
  source_phone: string | null;
  source_email: string | null;
  source_profile_id: string | null;
  source_party: string | null;
  source_gender: string | null;
  raw_answer: string | null;
  answered_at: string | null;
};

export type PreviewIssue =
  | 'ready'
  | 'unmatched'
  | 'existing'
  | 'conflict_response'
  | 'conflict_identity'
  | 'invalid';

export type PreviewRow = ParsedPollRow & {
  normalized_answer: PollAnswer;
  person_key: string;
  match_method: MatchMethod;
  match_status: MatchStatus;
  voter_id: number | null;
  voter_name: string | null;
  issue: PreviewIssue;
  issue_detail: string | null;
  existing_response_id: number | null;
  existing_answer: PollAnswer | null;
};

export type PreviewSummary = {
  poll_date: string;
  filename: string;
  file_hash: string | null;
  hash_warning: boolean;
  csv_rows: number;
  ready: number;
  matched: number;
  unmatched: number;
  existing: number;
  conflicts: number;
  identity_conflicts: number;
  invalid: number;
  rows: PreviewRow[];
};

export type PersonHistoryRow = {
  person_key: string;
  voter_id: number | null;
  name: string | null;
  phone: string | null;
  email: string | null;
  profile_id: string | null;
  first_poll: string | null;
  latest_poll: string | null;
  polls_answered: number;
  first_answer: PollAnswer | null;
  previous_answer: PollAnswer | null;
  current_answer: PollAnswer | null;
  movement: MovementKind | null;
  history: Array<{
    poll_date: string;
    answer: PollAnswer;
    raw_answer: string | null;
    movement: MovementKind | null;
  }>;
  matched: boolean;
  stable: boolean;
};

export type PersonTableFilter =
  | 'all'
  | 'first'
  | 'repeat'
  | 'changed'
  | 'toward'
  | 'away'
  | 'none'
  | 'neutral'
  | 'current_TODD'
  | 'current_RISCH'
  | 'current_UNDECIDED'
  | `${PollAnswer}>${PollAnswer}`;
