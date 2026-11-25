"use client";

import {
  sanitizeUrl,
  MAX_BIO_LENGTH,
  MAX_SKILLS,
  MAX_LINKS,
  MAX_HIGHLIGHTS,
  MAX_TESTIMONIAL_LENGTH,
} from "@/lib/sanitize";

export {
  MAX_BIO_LENGTH,
  MAX_SKILLS,
  MAX_LINKS,
  MAX_HIGHLIGHTS,
  MAX_TESTIMONIAL_LENGTH,
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ExternalLink {
  label: string; // e.g. "GitHub", "LinkedIn", "Website"
  url: string;
}

export interface Testimonial {
  /** Job ID the testimonial is associated with. */
  jobId: number;
  /** Stellar address of the client who left the testimonial. */
  clientAddress: string;
  /** Free-text testimonial body (max 500 chars). */
  text: string;
  /** Unix timestamp (ms) when the testimonial was submitted. */
  createdAt: number;
}

export interface Portfolio {
  /** Version tag so we can migrate stored data in future. */
  version: 1;
  bio: string;
  skills: string[]; // ordered, deduped
  links: ExternalLink[];
  /** Highlighted completed job IDs chosen by the owner. */
  highlightedJobIds: number[];
}

// ─── Storage keys ─────────────────────────────────────────────────────────────

function portfolioKey(address: string): string {
  return `stellarwork:portfolio:${address}`;
}

function testimonialsKey(address: string): string {
  return `stellarwork:testimonials:${address}`;
}

// ─── Empty defaults ───────────────────────────────────────────────────────────

export function emptyPortfolio(): Portfolio {
  return { version: 1, bio: "", skills: [], links: [], highlightedJobIds: [] };
}

// ─── Load ─────────────────────────────────────────────────────────────────────

export function loadPortfolio(address: string): Portfolio {
  if (typeof window === "undefined") return emptyPortfolio();
  try {
    const raw = localStorage.getItem(portfolioKey(address));
    if (!raw) return emptyPortfolio();
    const parsed = JSON.parse(raw) as Partial<Portfolio>;
    return {
      version: 1,
      bio: typeof parsed.bio === "string"
        ? parsed.bio.slice(0, MAX_BIO_LENGTH)
        : "",
      skills: Array.isArray(parsed.skills)
        ? parsed.skills
            .filter((s): s is string => typeof s === "string")
            .slice(0, MAX_SKILLS)
        : [],
      links: Array.isArray(parsed.links)
        ? parsed.links
            .filter(
              (l): l is ExternalLink =>
                l !== null &&
                typeof l === "object" &&
                typeof l.label === "string" &&
                typeof l.url === "string",
            )
            .slice(0, MAX_LINKS)
        : [],
      highlightedJobIds: Array.isArray(parsed.highlightedJobIds)
        ? parsed.highlightedJobIds
            .filter((id): id is number => typeof id === "number" && Number.isInteger(id))
            .slice(0, MAX_HIGHLIGHTS)
        : [],
    };
  } catch {
    return emptyPortfolio();
  }
}

export function savePortfolio(address: string, portfolio: Portfolio): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(portfolioKey(address), JSON.stringify(portfolio));
  } catch {
    /* quota exceeded – ignore */
  }
}

export function loadTestimonials(address: string): Testimonial[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(testimonialsKey(address));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t): t is Testimonial =>
        t !== null &&
        typeof t === "object" &&
        typeof t.jobId === "number" &&
        Number.isInteger(t.jobId) &&
        typeof t.clientAddress === "string" &&
        typeof t.text === "string" &&
        typeof t.createdAt === "number",
    ).map((t) => ({ ...t, text: t.text.slice(0, MAX_TESTIMONIAL_LENGTH) }));
  } catch {
    return [];
  }
}

export function saveTestimonials(
  address: string,
  testimonials: Testimonial[],
): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(
      testimonialsKey(address),
      JSON.stringify(testimonials),
    );
  } catch {
    /* quota exceeded – ignore */
  }
}

/**
 * Add or replace a testimonial for a given freelancer address + job.
 * A client can only leave one testimonial per job.
 */
export function upsertTestimonial(
  freelancerAddress: string,
  testimonial: Testimonial,
): void {
  const existing = loadTestimonials(freelancerAddress);
  const idx = existing.findIndex(
    (t) =>
      t.jobId === testimonial.jobId &&
      t.clientAddress === testimonial.clientAddress,
  );
  if (idx >= 0) {
    existing[idx] = testimonial;
  } else {
    existing.push(testimonial);
  }
  saveTestimonials(freelancerAddress, existing);
}

// ─── Verification badge ───────────────────────────────────────────────────────

/**
 * A profile is considered "verified complete" when it has:
 *  - a bio of at least 20 characters
 *  - at least 1 skill
 *  - at least 1 external link
 *  - at least 1 completed job highlighted
 */
export function isProfileComplete(portfolio: Portfolio): boolean {
  return (
    portfolio.bio.trim().length >= 20 &&
    portfolio.skills.length >= 1 &&
    portfolio.links.length >= 1 &&
    portfolio.highlightedJobIds.length >= 1
  );
}

// ─── Validation helpers ───────────────────────────────────────────────────────

export { sanitizeUrl } from "@/lib/sanitize";
