export type DisputeStatus =
  | "Active"
  | "Resolved"
  | "PendingEvidence"
  | "UnderReview"
  | "Closed";

export interface Dispute {
  id: string;
  jobId: string;
  jobTitle: string;
  client: string;
  freelancer: string;
  amount: number;
  raisedBy: "client" | "freelancer";
  raisedAt: string;
  status: DisputeStatus;
  reason: string;
  evidence?: string;
  resolution?: {
    resolvedAt: string;
    clientShare: number;
    freelancerShare: number;
    note: string;
  };
}

export interface EligibleJob {
  id: string;
  title: string;
  counterparty: string;
  amount: number;
}

export type DisputesPageData = {
  disputes: Dispute[];
  eligibleJobs: EligibleJob[];
};

export async function loadDisputesPageData(wallet: string): Promise<DisputesPageData> {
  const { getJobCount, getJob } = await import("@/lib/contract");
  const count = await getJobCount();

  const disputes: Dispute[] = [];
  const eligibleJobs: EligibleJob[] = [];

  for (let id = 1; id <= count; id++) {
    const job = await getJob(String(id));
    if (!job) continue;

    if (job.client !== wallet && job.freelancer !== wallet) continue;

    if (job.status === "Disputed") {
      // #1332: `raisedBy` must reflect who actually raised the dispute, not
      // which role the current viewer holds. The contract stores the disputing
      // party in `job.disputed_by` (the caller of `job_disputed`); fall back to
      // "unknown" when the field is absent rather than guessing from the viewer.
      // `raisedAt` is derived from the event timestamp stored on the job
      // (`job.disputed_at`, unix seconds) so it is stable across reloads and
      // the same for both participants.
      const disputedBy: string | undefined = (job as Record<string, unknown>).disputed_by as string | undefined;
      let raisedBy: "client" | "freelancer" | "unknown";
      if (disputedBy === job.client) {
        raisedBy = "client";
      } else if (disputedBy === job.freelancer) {
        raisedBy = "freelancer";
      } else {
        raisedBy = "unknown";
      }

      const disputedAtSec: number | undefined = (job as Record<string, unknown>).disputed_at as number | undefined;
      const raisedAt = disputedAtSec
        ? new Date(Number(disputedAtSec) * 1000).toISOString()
        : new Date(Number(job.created_at) * 1000).toISOString();

      disputes.push({
        id: `D-${String(id).padStart(3, "0")}`,
        jobId: String(id),
        jobTitle: `Job #${id}`,
        client: job.client,
        freelancer: job.freelancer ?? "unknown",
        amount: Number(job.amount),
        raisedBy: raisedBy as "client" | "freelancer",
        raisedAt,
        status: "Active",
        reason: "Dispute raised on-chain. See job details for more information.",
      });
    }

    if (job.status === "InProgress" || job.status === "SubmittedForReview") {
      eligibleJobs.push({
        id: String(id),
        title: `Job #${id}`,
        counterparty: job.client === wallet ? (job.freelancer ?? "unknown") : job.client,
        amount: Number(job.amount),
      });
    }
  }

  return { disputes, eligibleJobs };
}
