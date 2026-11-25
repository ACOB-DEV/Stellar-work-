/**
 * Calling library — Daily.co-based video/voice calling integration.
 *
 * Architecture:
 * - Each call gets a unique room name derived from both participants' addresses
 * - Daily.co Prebuilt is embedded via iframe for simplicity and mobile support
 * - No signaling server needed — Daily.co handles room creation and signaling
 *
 * In production, replace DAILY_DOMAIN with your Daily.co domain and
 * implement token-based room creation via a backend endpoint.
 */

const DAILY_DOMAIN = process.env.NEXT_PUBLIC_DAILY_DOMAIN || "stellarvork.daily.co";

export type CallType = "audio" | "video";

export interface CallRecord {
  id: string;
  /** #1331: ownerAddress scopes the record to the wallet that initiated it. */
  ownerAddress: string;
  peerAddress: string;
  type: CallType;
  startedAt: number;
  endedAt?: number;
  duration?: number;
  status: "ringing" | "connected" | "ended" | "missed";
}

// #1331: history key is scoped per-wallet so records from different connected
// accounts cannot bleed into each other. Legacy records (no ownerAddress) are
// discarded on first read rather than being shown to the wrong wallet.
function historyKey(ownerAddress: string): string {
  return `sw:call-history:${ownerAddress.toLowerCase()}`;
}

function generateRoomName(addr1: string, addr2: string): string {
  const sorted = [addr1.toLowerCase(), addr2.toLowerCase()].sort();
  const hash = Array.from(sorted.join(""))
    .reduce((acc, c) => ((acc << 5) - acc + c.charCodeAt(0)) | 0, 0);
  return `call-${Math.abs(hash).toString(36)}`;
}

function generateCallId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function getDailyUrl(
  myAddress: string,
  peerAddress: string,
  callType: CallType,
  userName: string,
): string {
  const room = generateRoomName(myAddress, peerAddress);

  const props: Record<string, string> = {
    domain: DAILY_DOMAIN,
    room: JSON.stringify({ name: room, privacy: "private" }),
    userName,
    audioSource: callType === "audio" ? "mic" : "mic,cam",
    videoSource: callType === "video" ? "camera" : "none",
    showLeaveButton: "true",
    showFullscreenButton: "true",
    "tray.hide": JSON.stringify([
      "chat",
      "screen-share",
      "recording",
      "caption",
      "emoji-reactions",
    ]),
  };

  const params = Object.entries(props)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  return `https://${DAILY_DOMAIN}/${room}?${params}`;
}

export function saveCallRecord(record: CallRecord): void {
  try {
    const history = loadCallHistory(record.ownerAddress);
    history.unshift(record);
    localStorage.setItem(historyKey(record.ownerAddress), JSON.stringify(history.slice(0, 50)));
  } catch {}
}

export function loadCallHistory(ownerAddress: string): CallRecord[] {
  try {
    const raw = localStorage.getItem(historyKey(ownerAddress));
    if (!raw) return [];
    const parsed: CallRecord[] = JSON.parse(raw);
    // Discard legacy records that pre-date the ownerAddress field (#1331).
    return parsed.filter((r) => r.ownerAddress === ownerAddress.toLowerCase());
  } catch {
    return [];
  }
}

export function updateCallRecord(id: string, ownerAddress: string, updates: Partial<CallRecord>): void {
  try {
    const history = loadCallHistory(ownerAddress);
    const idx = history.findIndex((r) => r.id === id);
    if (idx !== -1) {
      history[idx] = { ...history[idx], ...updates };
      localStorage.setItem(historyKey(ownerAddress), JSON.stringify(history.slice(0, 50)));
    }
  } catch {}
}
