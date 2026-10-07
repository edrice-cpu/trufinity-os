export interface NavItem {
  href: string;
  label: string;
  icon: string;
}

export const navItems: NavItem[] = [
  { href: "/dashboard", label: "Main Dashboard", icon: "grid" },
  { href: "/daily-brief", label: "Daily Executive Brief", icon: "sun" },
  { href: "/demand-alerts", label: "Demand Alerts", icon: "bell" },
  { href: "/financial-alerts", label: "Financial Alerts", icon: "alert-circle" },
  { href: "/field-operations", label: "Field Operations", icon: "building" },
  { href: "/scorecard", label: "Scorecard", icon: "bar-chart" },
  { href: "/escalations", label: "Customer Escalations", icon: "alert-circle" },
  { href: "/red-flags", label: "Red Flags", icon: "flag" },
  { href: "/responsiveness", label: "Responsiveness", icon: "clock" },
  { href: "/marketing", label: "Marketing", icon: "megaphone" },
  { href: "/watchlist", label: "Watch List & Opportunities", icon: "eye" },
  { href: "/closed-loop", label: "Closed Loop", icon: "check-circle" },
  { href: "/data-quality", label: "Data Quality", icon: "wrench" },
  { href: "/integrations", label: "Integrations", icon: "plug" },
];
