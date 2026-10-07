import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { FormAlert } from "@/components/auth/form-controls";
import { buttonClassName } from "@/components/integrations/button-styles";
import { FormButton } from "@/components/integrations/form-button";
import { DetailList, IntegrationCard, ProviderMark, StatusBadge } from "@/components/integrations/integration-card";
import { PageHeader } from "@/components/ui/PageHeader";
import { getSessionToken } from "@/lib/auth/session";
import { getIntegrationsStatus, type QuickBooksStatus, type ServiceTitanStatus } from "@/lib/integrations";
import { connectQuickBooksAction, refreshStatusAction } from "./actions";

export const metadata: Metadata = {
  title: "Integrations · TruFinity",
  robots: { index: false, follow: false },
};

const LOGIN_PATH = "/login?next=/integrations";

const quickBooksNotices: Record<string, { tone: "success" | "error"; message: string }> = {
  connected: { tone: "success", message: "QuickBooks connected successfully." },
  denied: { tone: "error", message: "QuickBooks connection was cancelled. No changes were made." },
  failed: { tone: "error", message: "We couldn't complete the QuickBooks connection. Please try again." },
};

const formatDate = (iso: string) =>
  new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(iso));

export default async function IntegrationsPage({ searchParams }: PageProps<"/integrations">) {
  const token = await getSessionToken();
  if (!token) redirect(LOGIN_PATH);

  const [params, result] = await Promise.all([searchParams, getIntegrationsStatus(token)]);
  if (result.kind === "unauthenticated") redirect(LOGIN_PATH);

  const notice = typeof params.quickbooks === "string" ? quickBooksNotices[params.quickbooks] : undefined;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Integrations"
        description="Connect the business systems TruFinity reads from. Data syncs automatically once a system is connected."
        action={
          <form action={refreshStatusAction}>
            <FormButton variant="secondary" pendingLabel="Checking…">
              Check status
            </FormButton>
          </form>
        }
      />

      {notice && <FormAlert tone={notice.tone}>{notice.message}</FormAlert>}

      {result.kind === "unavailable" ? (
        <FormAlert tone="error">We couldn&apos;t load integration status right now. Please try again in a moment.</FormAlert>
      ) : (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <QuickBooksCard status={result.status.quickbooks} />
          <ServiceTitanCard status={result.status.servicetitan} />
        </div>
      )}
    </div>
  );
}

function QuickBooksCard({ status }: { status: QuickBooksStatus }) {
  const expired = !status.connected && status.realmId !== null;
  const badge = status.connected ? (
    <StatusBadge tone="connected" label="Connected" />
  ) : expired ? (
    <StatusBadge tone="warning" label="Reconnect required" />
  ) : (
    <StatusBadge tone="disconnected" label="Not connected" />
  );

  return (
    <IntegrationCard
      name="QuickBooks Online"
      description="Accounting: customers, invoices, payments and accounts."
      logo={<ProviderMark initials="QB" className="bg-[#2CA01C]" />}
      badge={badge}
    >
      {status.realmId ? (
        <DetailList
          items={[
            ...(status.companyName ? [{ label: "Company", value: status.companyName }] : []),
            { label: "Company ID (realm)", value: status.realmId },
            ...(status.refreshTokenExpiresAt
              ? [{ label: status.connected ? "Authorization valid until" : "Authorization expired", value: formatDate(status.refreshTokenExpiresAt) }]
              : []),
          ]}
        />
      ) : (
        <p className="text-sm leading-6 text-foreground/60">
          You&apos;ll be taken to Intuit to sign in and choose the QuickBooks company to connect, then brought back here.
        </p>
      )}

      <div className="mt-auto flex flex-col gap-2">
        <form action={connectQuickBooksAction}>
          <FormButton pendingLabel="Redirecting to Intuit…" disabled={!status.configured}>
            {status.realmId ? "Reconnect QuickBooks" : "Connect QuickBooks"}
          </FormButton>
        </form>
        {!status.configured && (
          <p className="text-xs text-warning">
            QuickBooks app credentials aren&apos;t configured on the server yet (QBO_CLIENT_ID, QBO_CLIENT_SECRET,
            QBO_AUTH_URL, QBO_TOKEN_URL, QBO_REDIRECT_URI).
          </p>
        )}
      </div>
    </IntegrationCard>
  );
}

function ServiceTitanCard({ status }: { status: ServiceTitanStatus }) {
  const badge = status.connected ? (
    <StatusBadge tone="connected" label="Connected" />
  ) : status.configured ? (
    <StatusBadge tone="warning" label="Connection failing" />
  ) : (
    <StatusBadge tone="disconnected" label="Not connected" />
  );

  return (
    <IntegrationCard
      name="ServiceTitan"
      description="Field service: customers, jobs, appointments, invoices and payments."
      logo={<ProviderMark initials="ST" className="bg-[#0F2B5B]" />}
      badge={badge}
    >
      {status.tenantId && <DetailList items={[{ label: "Tenant ID", value: status.tenantId }]} />}

      {!status.connected && (
        <div className="flex flex-col gap-2 text-sm leading-6 text-foreground/60">
          <p>ServiceTitan access is granted by a tenant admin inside ServiceTitan:</p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              Open ServiceTitan and go to <span className="font-medium text-foreground">Settings → Integrations → API Application Access</span>.
            </li>
            <li>
              Click <span className="font-medium text-foreground">Connect New App</span>, select the TruFinity app, and choose <span className="font-medium text-foreground">Allow Access</span>.
            </li>
            <li>Securely share the generated Client ID and Client Secret with your TruFinity administrator.</li>
          </ol>
          {status.configured && (
            <p className="text-warning">
              Credentials are configured but ServiceTitan rejected them. Access may have been revoked; reconnect the app in ServiceTitan.
            </p>
          )}
        </div>
      )}

      <div className="mt-auto flex flex-wrap gap-2">
        <a href={status.connectUrl} target="_blank" rel="noopener noreferrer" className={buttonClassName(status.connected ? "secondary" : "primary")}>
          {status.connected ? "Open ServiceTitan" : "Connect in ServiceTitan"}
          <span aria-hidden="true">↗</span>
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      </div>
    </IntegrationCard>
  );
}
