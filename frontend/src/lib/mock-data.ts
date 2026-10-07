import type {
  ClosedLoopItem,
  FlaggedItem,
  KpiMetric,
  MarketingMetric,
  ResponsivenessRow,
  ReviewItem,
  ScorecardMetric,
  WatchListItem,
} from "./types";

export const companyMeta = {
  name: "TruFinity Plumbing Heating & Cooling",
  shortName: "TruFinity PHC",
  reportDate: "Tuesday, September 1, 2026",
  timezone: "PST",
};

export const overviewKpis: KpiMetric[] = [
  { id: "revenue-today", label: "Revenue (Today)", value: "$18,420", delta: "+12.4%", trend: "up", helpText: "vs. same weekday avg" },
  { id: "jobs-completed", label: "Jobs Completed", value: "27", delta: "+3", trend: "up", helpText: "vs. yesterday" },
  { id: "avg-ticket", label: "Average Ticket", value: "$682", delta: "-4.1%", trend: "down", helpText: "vs. 7-day avg" },
  { id: "open-red-flags", label: "Open Red Flags", value: "5", delta: "+2", trend: "up", helpText: "needs attention" },
  { id: "open-escalations", label: "Customer Escalations", value: "3", delta: "0", trend: "flat", helpText: "unchanged since yesterday" },
  { id: "csat", label: "CSAT (7-day)", value: "4.6 / 5", delta: "+0.1", trend: "up", helpText: "based on 42 responses" },
];

export const dailyBrief = {
  summary:
    "Solid day overall — revenue is ahead of the weekday average and technician utilization stayed high. Two items need executive attention: a delayed HVAC install for a repeat commercial customer and a billing dispute that has gone unanswered for over 24 hours.",
  highlights: [
    "Revenue finished 12.4% above the trailing weekday average, driven by 4 emergency service calls.",
    "Membership renewals: 6 completed today, putting the month at 78% of target.",
    "Technician Ravi P. closed 3 same-day jobs with 5-star reviews on all three.",
  ],
  watchOuts: [
    "Commercial HVAC install for Meridian Logistics is 2 days behind schedule — parts backorder.",
    "Invoice #10432 billing dispute from Linda K. has no response after 26 hours.",
    "Call abandon rate ticked up to 8.2% during the 12–2 PM window.",
  ],
  metrics: overviewKpis.slice(0, 4),
};

export const scorecard: ScorecardMetric[] = [
  { id: "sc-1", category: "Revenue", metric: "Daily Revenue", today: "$18,420", target: "$16,000", status: "on_track", trend: [12, 14, 11, 16, 15, 18, 18.4] },
  { id: "sc-2", category: "Revenue", metric: "Average Ticket", today: "$682", target: "$710", status: "at_risk", trend: [720, 705, 698, 690, 700, 685, 682] },
  { id: "sc-3", category: "Operations", metric: "Jobs Completed", today: "27", target: "25", status: "on_track", trend: [20, 22, 24, 21, 26, 25, 27] },
  { id: "sc-4", category: "Operations", metric: "Technician Utilization", today: "84%", target: "80%", status: "on_track", trend: [76, 78, 79, 81, 80, 83, 84] },
  { id: "sc-5", category: "Customer", metric: "CSAT Score", today: "4.6", target: "4.5", status: "on_track", trend: [4.4, 4.5, 4.3, 4.6, 4.5, 4.7, 4.6] },
  { id: "sc-6", category: "Customer", metric: "Open Escalations", today: "3", target: "0", status: "off_track", trend: [1, 2, 2, 1, 3, 2, 3] },
  { id: "sc-7", category: "Marketing", metric: "New Leads", today: "9", target: "10", status: "at_risk", trend: [11, 8, 10, 9, 12, 7, 9] },
  { id: "sc-8", category: "Marketing", metric: "Review Rating (30-day)", today: "4.7", target: "4.5", status: "on_track", trend: [4.6, 4.6, 4.7, 4.7, 4.6, 4.8, 4.7] },
];

export const flaggedItems: FlaggedItem[] = [
  {
    id: "fi-1001",
    type: "escalation",
    title: "Billing dispute — duplicate charge",
    customer: "Linda K.",
    invoiceNumber: "INV-10432",
    priority: "high",
    status: "open",
    source: "Phone (Dialpad)",
    amount: "$412.00",
    assignedTo: "Priya S. (Office Manager)",
    createdAt: "2026-08-31 09:14 AM",
    description:
      "Customer states she was charged twice for the same drain cleaning visit. First charge on Invoice #10398 and a second identical charge on Invoice #10432. No response has been sent to the customer in over 24 hours.",
    timeline: [
      { timestamp: "2026-08-31 09:14 AM", actor: "Linda K.", action: "Called in reporting duplicate charge." },
      { timestamp: "2026-08-31 09:20 AM", actor: "System", action: "Escalation auto-flagged: no response after 15 min on high-priority billing tag." },
      { timestamp: "2026-08-31 11:02 AM", actor: "Priya S.", action: "Reviewed invoices, confirmed duplicate. Refund pending manager approval." },
    ],
    relatedMessages: [
      { from: "Linda K.", channel: "Phone", timestamp: "2026-08-31 09:14 AM", snippet: "I was charged twice for the same visit, can someone call me back today?" },
    ],
  },
  {
    id: "fi-1002",
    type: "red_flag",
    title: "Commercial install delayed — parts backorder",
    customer: "Meridian Logistics",
    jobNumber: "JOB-88213",
    priority: "critical",
    status: "in_progress",
    source: "ServiceTitan",
    assignedTo: "Marcus T. (Dispatch Lead)",
    createdAt: "2026-08-30 07:45 AM",
    description:
      "HVAC unit install for Meridian Logistics warehouse is now 2 business days behind the committed schedule due to a backordered compressor unit. Customer is a repeat commercial account with a service agreement.",
    timeline: [
      { timestamp: "2026-08-30 07:45 AM", actor: "System", action: "Job flagged: scheduled completion date missed." },
      { timestamp: "2026-08-30 10:30 AM", actor: "Marcus T.", action: "Contacted supplier — compressor ETA pushed to Sept 3." },
      { timestamp: "2026-08-31 08:00 AM", actor: "Marcus T.", action: "Notified customer of revised timeline, offered temporary cooling unit." },
    ],
  },
  {
    id: "fi-1003",
    type: "red_flag",
    title: "Negative review — 2 stars",
    customer: "Robert G.",
    priority: "medium",
    status: "open",
    source: "Google Business Profile",
    createdAt: "2026-08-31 06:20 PM",
    description:
      "Customer left a 2-star review citing a technician who arrived 90 minutes past the scheduled window without a courtesy call.",
    timeline: [
      { timestamp: "2026-08-31 06:20 PM", actor: "Robert G.", action: "Posted 2-star review on Google Business Profile." },
      { timestamp: "2026-08-31 06:45 PM", actor: "System", action: "Flagged for response — no reply within SLA window." },
    ],
    relatedMessages: [
      { from: "Robert G.", channel: "Google Review", timestamp: "2026-08-31 06:20 PM", snippet: "Tech showed up almost 2 hours late with no call. Work was fine but the wait was unacceptable." },
    ],
  },
  {
    id: "fi-1004",
    type: "escalation",
    title: "Warranty claim — repeat failure",
    customer: "Anthony D.",
    jobNumber: "JOB-88190",
    priority: "high",
    status: "open",
    source: "ServiceTitan",
    assignedTo: "Priya S. (Office Manager)",
    createdAt: "2026-08-31 01:10 PM",
    description: "Water heater installed 3 weeks ago has failed a second time. Customer is requesting a full replacement rather than another repair.",
    timeline: [
      { timestamp: "2026-08-31 01:10 PM", actor: "Anthony D.", action: "Called reporting second failure of newly installed water heater." },
      { timestamp: "2026-08-31 01:30 PM", actor: "Priya S.", action: "Escalated to install team lead for warranty review." },
    ],
  },
  {
    id: "fi-1005",
    type: "red_flag",
    title: "Overdue invoice — 45+ days",
    customer: "Green Valley HOA",
    invoiceNumber: "INV-10201",
    priority: "medium",
    status: "in_progress",
    source: "QuickBooks",
    amount: "$2,140.00",
    assignedTo: "Priya S. (Office Manager)",
    createdAt: "2026-08-25 09:00 AM",
    description: "Commercial account invoice is 45 days past due. Two payment reminders sent with no response.",
    timeline: [
      { timestamp: "2026-08-25 09:00 AM", actor: "System", action: "Invoice flagged as 45+ days overdue." },
      { timestamp: "2026-08-27 10:00 AM", actor: "Priya S.", action: "Sent second payment reminder email." },
    ],
  },
  {
    id: "fi-1006",
    type: "red_flag",
    title: "Missed callback window",
    customer: "Sandra M.",
    priority: "low",
    status: "resolved",
    source: "Dialpad",
    assignedTo: "Front Desk",
    createdAt: "2026-08-29 03:40 PM",
    description: "Customer requested a callback for a quote that was not returned within the 2-hour SLA.",
    timeline: [
      { timestamp: "2026-08-29 03:40 PM", actor: "System", action: "Callback SLA breached." },
      { timestamp: "2026-08-29 05:10 PM", actor: "Front Desk", action: "Callback completed, quote provided." },
      { timestamp: "2026-08-29 05:15 PM", actor: "Front Desk", action: "Marked resolved." },
    ],
  },
];

export const responsiveness: ResponsivenessRow[] = [
  { id: "rs-1", channel: "Phone (Dialpad)", metric: "Answer Rate", today: "91.8%", weekAvg: "89.2%", target: "90%", status: "on_track" },
  { id: "rs-2", channel: "Phone (Dialpad)", metric: "Avg. Wait Time", today: "48s", weekAvg: "55s", target: "45s", status: "at_risk" },
  { id: "rs-3", channel: "Phone (Dialpad)", metric: "Abandon Rate", today: "8.2%", weekAvg: "6.4%", target: "5%", status: "off_track" },
  {
    id: "rs-4",
    channel: "AI Call Agent (Lace AI)",
    metric: "Call Answer Time",
    today: "6s",
    weekAvg: "8s",
    target: "10s",
    status: "on_track",
    syncNote: "Call Analysis Export · synced daily via SFTP",
  },
  {
    id: "rs-5",
    channel: "AI Call Agent (Lace AI)",
    metric: "Call Resolution Rate",
    today: "88%",
    weekAvg: "85%",
    target: "85%",
    status: "on_track",
    syncNote: "Agent Performance Export · synced daily via SFTP",
  },
  { id: "rs-6", channel: "Email (service@)", metric: "First Response Time", today: "2h 10m", weekAvg: "3h 05m", target: "4h", status: "on_track" },
  { id: "rs-7", channel: "Google Business Profile", metric: "Review Response Time", today: "5h 40m", weekAvg: "9h 20m", target: "24h", status: "on_track" },
];

export const marketingMetrics: MarketingMetric[] = [
  { id: "mk-1", label: "Google Ads Spend (MTD)", value: "$4,280", delta: "+6.2%", trend: "up" },
  { id: "mk-2", label: "Cost per Lead", value: "$47.60", delta: "-3.4%", trend: "down" },
  { id: "mk-3", label: "New Leads (MTD)", value: "90", delta: "+11%", trend: "up" },
  { id: "mk-4", label: "Google Business Profile Views", value: "3,120", delta: "+4.8%", trend: "up" },
  { id: "mk-5", label: "New Reviews (MTD)", value: "18", delta: "+2", trend: "up" },
  { id: "mk-6", label: "Average Rating", value: "4.7", delta: "+0.1", trend: "up" },
];

export const recentReviews: ReviewItem[] = [
  { id: "rv-1", customer: "Alicia N.", rating: 5, platform: "Google", date: "2026-08-31", snippet: "Fast, professional, and explained everything clearly. Highly recommend!", responded: true },
  { id: "rv-2", customer: "Robert G.", rating: 2, platform: "Google", date: "2026-08-31", snippet: "Tech showed up almost 2 hours late with no call.", responded: false },
  { id: "rv-3", customer: "Marcus H.", rating: 5, platform: "Yelp", date: "2026-08-30", snippet: "Same-day AC repair during the heat wave, saved us. Great crew.", responded: true },
  { id: "rv-4", customer: "Deja W.", rating: 4, platform: "Google", date: "2026-08-29", snippet: "Good work overall, pricing was a little higher than expected.", responded: false },
];

export const watchList: WatchListItem[] = [
  { id: "wl-1", title: "Meridian Logistics — service agreement renewal", category: "opportunity", customer: "Meridian Logistics", value: "$8,400 / yr", note: "Renewal due in 30 days; strong candidate for a maintenance plan upsell after current install wraps up.", dueDate: "2026-10-01", owner: "Daniel" },
  { id: "wl-2", title: "Green Valley HOA — payment risk", category: "watch", customer: "Green Valley HOA", value: "$2,140", note: "Overdue invoice combined with slow email response; monitor for pattern before next service call.", dueDate: "2026-09-05", owner: "Priya S." },
  { id: "wl-3", title: "Anthony D. — warranty replacement decision", category: "watch", customer: "Anthony D.", note: "Second water heater failure in 3 weeks; decision on full replacement needed to protect review sentiment.", dueDate: "2026-09-02", owner: "Install Team Lead" },
  { id: "wl-4", title: "Bundled tune-up promo — fall campaign", category: "opportunity", customer: "General / Marketing", value: "Est. $12,000 potential", note: "Historical fall tune-up campaigns have converted well; slot into Google Ads for late September.", dueDate: "2026-09-15", owner: "Daniel" },
];

export const closedLoop: ClosedLoopItem[] = [
  { id: "cl-1", title: "Missed callback window", customer: "Sandra M.", resolutionType: "red_flag", closedDate: "2026-08-29", resolvedBy: "Front Desk", outcome: "Callback completed same day; customer booked the quoted job." },
  { id: "cl-2", title: "Duplicate charge — resolved refund", customer: "Frank O.", resolutionType: "escalation", closedDate: "2026-08-28", resolvedBy: "Priya S.", outcome: "Refund issued within 24 hours; customer confirmed satisfaction." },
  { id: "cl-3", title: "Membership plan upsell", customer: "The Whitfield Family", resolutionType: "opportunity", closedDate: "2026-08-27", resolvedBy: "Ravi P.", outcome: "Converted to annual maintenance membership during service visit." },
  { id: "cl-4", title: "Negative review follow-up", customer: "Ken B.", resolutionType: "red_flag", closedDate: "2026-08-26", resolvedBy: "Daniel", outcome: "Owner responded publicly and resolved offline; customer updated review to 4 stars." },
];

export function getFlaggedItemById(id: string): FlaggedItem | undefined {
  return flaggedItems.find((item) => item.id === id);
}
