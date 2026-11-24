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
  /** Raw contract base units kept as bigint to avoid Number.MAX_SAFE_INTEGER truncation. */
  amount: bigint;
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
  /** Raw contract base units kept as bigint to avoid Number.MAX_SAFE_INTEGER truncation. */
  amount: bigint;
}

/** Integer basis-point split: returns clientAmount and freelancerAmount summing to total. */
export function splitByBps(total: bigint, clientBps: number): { clientAmount: bigint; freelancerAmount: bigint } {
  const clientAmount = (total * BigInt(clientBps)) / BigInt(100);
  const freelancerAmount = total - clientAmount;
  return { clientAmount, freelancerAmount };
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
  const now = new Date().toISOString();

  for (let id = 1; id <= count; id++) {
    const job = await getJob(String(id));
    if (!job) continue;

    if (job.client !== wallet && job.freelancer !== wallet) continue;

    if (job.status === "Disputed") {
      disputes.push({
        id: `D-${String(id).padStart(3, "0")}`,
        jobId: String(id),
        jobTitle: `Job #${id}`,
        client: job.client,
        freelancer: job.freelancer ?? "unknown",
        amount: BigInt(job.amount),
        raisedBy: job.client === wallet ? "client" : "freelancer",
        raisedAt: now,
        status: "Active",
        reason: "Dispute raised on-chain. See job details for more information.",
      });
    }

    if (job.status === "InProgress" || job.status === "SubmittedForReview") {
      eligibleJobs.push({
        id: String(id),
        title: `Job #${id}`,
        counterparty: job.client === wallet ? (job.freelancer ?? "unknown") : job.client,
        amount: BigInt(job.amount),
      });
    }
  }

  return { disputes, eligibleJobs };
}
