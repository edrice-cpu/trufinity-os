// Which dashboard sections have live backend data. Flip a flag to true when its API is wired.
export const sectionReady = {
  financialOverview: true,
  dataQuality: true,
  fieldOperations: true,
  demandAlerts: true,
  briefHeader: true,
  scorecard: false,
  escalations: false,
  redFlags: false,
  responsiveness: false,
  marketing: false,
  watchList: false,
  opportunities: false,
  closedLoop: false,
} as const;

export type SectionId = keyof typeof sectionReady;
