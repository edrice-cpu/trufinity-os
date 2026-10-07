export type Priority = "critical" | "high" | "medium" | "low";

export type FlagStatus = "open" | "in_progress" | "resolved" | "closed";

export type TrendDirection = "up" | "down" | "flat";

export interface KpiMetric {
  id: string;
  label: string;
  value: string;
  delta?: string;
  trend?: TrendDirection;
  helpText?: string;
}

export interface ScorecardMetric {
  id: string;
  category: string;
  metric: string;
  today: string;
  target: string;
  status: "on_track" | "at_risk" | "off_track";
  trend: number[];
}

export interface FlaggedItem {
  id: string;
  type: "escalation" | "red_flag";
  title: string;
  customer: string;
  jobNumber?: string;
  invoiceNumber?: string;
  priority: Priority;
  status: FlagStatus;
  source: string;
  amount?: string;
  assignedTo?: string;
  createdAt: string;
  description: string;
  timeline: {
    timestamp: string;
    actor: string;
    action: string;
  }[];
  relatedMessages?: {
    from: string;
    channel: string;
    timestamp: string;
    snippet: string;
  }[];
}

export interface ResponsivenessRow {
  id: string;
  channel: string;
  metric: string;
  today: string;
  weekAvg: string;
  target: string;
  status: "on_track" | "at_risk" | "off_track";
  syncNote?: string;
}

export interface MarketingMetric {
  id: string;
  label: string;
  value: string;
  delta: string;
  trend: TrendDirection;
}

export interface ReviewItem {
  id: string;
  customer: string;
  rating: number;
  platform: string;
  date: string;
  snippet: string;
  responded: boolean;
}

export interface WatchListItem {
  id: string;
  title: string;
  category: "watch" | "opportunity";
  customer: string;
  value?: string;
  note: string;
  dueDate?: string;
  owner: string;
}

export interface ClosedLoopItem {
  id: string;
  title: string;
  customer: string;
  resolutionType: "escalation" | "red_flag" | "opportunity";
  closedDate: string;
  resolvedBy: string;
  outcome: string;
}
