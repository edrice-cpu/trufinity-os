import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardHeader } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { Pill } from "@/components/ui/Badge";
import { PendingState } from "@/components/ui/States";
import { sectionReady } from "@/lib/sections";
import type { MarketingMetric, ReviewItem } from "@/lib/types";

// TODO: replace with marketing API data once available.
const marketingMetrics: MarketingMetric[] = [];
const recentReviews: ReviewItem[] = [];

const trendStyles = { up: "text-success", down: "text-danger", flat: "text-foreground/50" } as const;
const trendIcon = { up: "arrow-up", down: "arrow-down", flat: "minus" } as const;

function Stars({ rating }: { rating: number }) {
  return (
    <div className="flex items-center gap-0.5 text-brand">
      {Array.from({ length: 5 }).map((_, i) => (
        <Icon key={i} name="star" className={`h-3.5 w-3.5 ${i < rating ? "text-brand" : "text-border-subtle"}`} />
      ))}
    </div>
  );
}

export default function MarketingPage() {
  return (
    <div>
      <PageHeader
        title="Marketing"
        description="Google Ads performance and online reputation across review platforms."
      />

      {!sectionReady.marketing ? (
        <PendingState />
      ) : (
      <>
      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6">
        {marketingMetrics.map((m) => (
          <Card key={m.id} className="flex flex-col gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-foreground/50">{m.label}</span>
            <span className="text-xl font-semibold text-foreground">{m.value}</span>
            <span className={`inline-flex items-center gap-1 text-xs font-medium ${trendStyles[m.trend]}`}>
              <Icon name={trendIcon[m.trend]} className="h-3.5 w-3.5" />
              {m.delta}
            </span>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader title="Recent reviews" subtitle="Latest customer reviews across Google & Yelp" />
        <div className="divide-y divide-border-subtle">
          {recentReviews.map((review) => (
            <div key={review.id} className="flex flex-col gap-2 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{review.customer}</span>
                  <Pill tone="teal">{review.platform}</Pill>
                  <span className="text-xs text-foreground/40">{review.date}</span>
                </div>
                <Stars rating={review.rating} />
                <p className="mt-1.5 text-sm text-foreground/70">&ldquo;{review.snippet}&rdquo;</p>
              </div>
              <Pill tone={review.responded ? "neutral" : "brand"}>
                {review.responded ? "Responded" : "Needs response"}
              </Pill>
            </div>
          ))}
        </div>
      </Card>
      </>
      )}
    </div>
  );
}
