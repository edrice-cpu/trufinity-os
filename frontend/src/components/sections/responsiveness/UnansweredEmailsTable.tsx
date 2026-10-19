import { formatDateTime } from "@/lib/format";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/States";
import { Pagination, FilterChips } from "@/components/ui/Pagination";
import { Pill } from "@/components/ui/Badge";
import type {
  UnansweredEmail,
  UnansweredEmailClassification,
  UnansweredEmailFilters,
} from "@/lib/api/responsiveness";

// ─── Badge helpers ────────────────────────────────────────────────────────────

const CLASSIFICATION_TONE: Record<UnansweredEmailClassification, string> = {
  EMERGENCY: "bg-danger-soft text-danger",
  GENERAL: "bg-info-soft text-info",
};

function ClassificationBadge({ isEmergency }: { isEmergency: boolean }) {
  const value: UnansweredEmailClassification = isEmergency ? "EMERGENCY" : "GENERAL";
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-medium capitalize ${CLASSIFICATION_TONE[value]}`}>
      {value.charAt(0) + value.slice(1).toLowerCase()}
    </span>
  );
}

function AgeCell({ minutes }: { minutes: number }) {
  const hours = minutes / 60;
  const tone = hours >= 48 ? "text-danger font-medium" : hours >= 24 ? "text-warning" : "text-foreground/60";
  const label =
    hours < 1
      ? "< 1 h"
      : hours < 24
        ? `${Math.round(hours)} h`
        : `${(hours / 24).toFixed(1)} d`;
  return <span className={`tabular-nums ${tone}`}>{label}</span>;
}

// ─── Filter chips config ──────────────────────────────────────────────────────

const CLASSIFICATION_OPTIONS: { value: UnansweredEmailClassification; label: string }[] = [
  { value: "EMERGENCY", label: "Emergency" },
  { value: "GENERAL", label: "General" },
];

// ─── Main component ───────────────────────────────────────────────────────────

const BASE_PATH = "/responsiveness";
const PAGE_SIZE = 20;

interface Props {
  items: UnansweredEmail[];
  total: number;
  page: number;
  activeFilters: UnansweredEmailFilters;
}

export function UnansweredEmailsTable({ items = [], total = 0, page, activeFilters }: Props) {
  const query: Record<string, string | undefined> = {
    classification: activeFilters.classification,
    mailbox_address: activeFilters.mailbox_address,
    status: activeFilters.status,
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Classification filter chips */}
      <FilterChips
        basePath={BASE_PATH}
        param="classification"
        options={CLASSIFICATION_OPTIONS}
        active={activeFilters.classification}
        query={{ mailbox_address: activeFilters.mailbox_address, status: activeFilters.status }}
      />

      <Card padded={false}>
        {items.length === 0 ? (
          <div className="p-6">
            <EmptyState icon="mail" title="No unanswered emails" description="All caught up — no emails match this filter." />
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[700px] text-left text-sm">
                <thead>
                  <tr className="border-b border-border-subtle bg-surface-muted/40 text-xs uppercase tracking-wide text-foreground/45">
                    <th className="px-5 py-3 font-medium sm:px-6">Thread</th>
                    <th className="px-5 py-3 font-medium sm:px-6">Mailbox</th>
                    <th className="px-5 py-3 font-medium sm:px-6">Classification</th>
                    <th className="px-5 py-3 font-medium sm:px-6">Received</th>
                    <th className="px-5 py-3 font-medium sm:px-6">Age</th>
                    <th className="px-5 py-3 font-medium sm:px-6">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {items.map((email) => (
                    <tr key={email.id} className="hover:bg-surface-muted/30 transition-colors">
                      <td className="px-5 py-3.5 sm:px-6">
                        <p className="font-medium text-foreground truncate max-w-[200px]">
                          {email.threadId}
                        </p>
                      </td>
                      <td className="px-5 py-3.5 text-foreground/60 sm:px-6">
                        <span className="truncate max-w-[160px] block">{email.mailboxAddress}</span>
                      </td>
                      <td className="px-5 py-3.5 sm:px-6">
                        <ClassificationBadge isEmergency={email.isEmergency} />
                      </td>
                      <td className="px-5 py-3.5 text-foreground/60 sm:px-6">
                        {formatDateTime(email.oldestUnansweredAt)}
                      </td>
                      <td className="px-5 py-3.5 sm:px-6">
                        <AgeCell minutes={email.businessMinutesElapsed} />
                      </td>
                      <td className="px-5 py-3.5 sm:px-6">
                        <Pill>{email.status.charAt(0) + email.status.slice(1).toLowerCase()}</Pill>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {total > PAGE_SIZE && (
              <Pagination
                basePath={BASE_PATH}
                query={query}
                page={page}
                pageSize={PAGE_SIZE}
                totalCount={total}
              />
            )}
          </>
        )}
      </Card>
    </div>
  );
}

