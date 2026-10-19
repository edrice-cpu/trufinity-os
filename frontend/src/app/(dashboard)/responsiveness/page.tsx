import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { ErrorState } from "@/components/ui/States";
import { UnansweredSummaryCards } from "@/components/sections/responsiveness/UnansweredSummaryCards";
import { UnansweredEmailsTable } from "@/components/sections/responsiveness/UnansweredEmailsTable";
import { getSessionToken } from "@/lib/auth/session";
import {
  listUnansweredEmails,
  getUnansweredSummary,
  type UnansweredEmailClassification,
  type UnansweredEmailStatus,
} from "@/lib/api/responsiveness";

export const metadata: Metadata = {
  title: "Responsiveness · TruFinity",
};

const PAGE_SIZE = 20;
const LOGIN_PATH = "/login?next=/responsiveness";

export default async function ResponsivenessPage({
  searchParams,
}: PageProps<"/responsiveness">) {
  const token = await getSessionToken();
  if (!token) redirect(LOGIN_PATH);

  const params = await searchParams;

  const page = Math.max(1, Number(params.page ?? 1));
  const classification = params.classification as UnansweredEmailClassification | undefined;
  const mailbox_address = params.mailbox_address as string | undefined;
  const status = params.status as UnansweredEmailStatus | undefined;

  const filters = { page, page_size: PAGE_SIZE, classification, mailbox_address, status };

  const [listResult, summaryResult] = await Promise.all([
    listUnansweredEmails(token, filters),
    getUnansweredSummary(token, mailbox_address),
  ]);

  if (listResult.kind === "unauthenticated" || summaryResult.kind === "unauthenticated") {
    redirect(LOGIN_PATH);
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Responsiveness"
        description="How quickly the business responds to customers across phone, AI call agent, email, and reviews."
      />

      {/* Summary stat cards */}
      {summaryResult.kind === "ok" ? (
        <UnansweredSummaryCards summary={summaryResult.data} />
      ) : (
        <ErrorState title="Couldn't load summary" description={summaryResult.message} />
      )}

      {/* Unanswered emails list */}
      <div>
        <h2 className="mb-3 text-sm font-semibold text-foreground">Unanswered Emails</h2>
        {listResult.kind === "ok" ? (
          <UnansweredEmailsTable
            items={listResult.data.data}
            total={listResult.data.totalCount}
            page={page}
            activeFilters={filters}
          />
        ) : (
          <ErrorState title="Couldn't load emails" description={listResult.message} />
        )}
      </div>
    </div>
  );
}
