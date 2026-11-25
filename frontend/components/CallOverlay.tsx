"use client";

import { useCallback, useEffect, useRef } from "react";
import TruncatedAddress from "@/components/TruncatedAddress";
import { useModalFocusTrap } from "@/lib/modal";
import { getDailyUrl, saveCallRecord, updateCallRecord, type CallType } from "@/lib/calling";

interface CallOverlayProps {
  myAddress: string;
  peerAddress: string;
  callType: CallType;
  userName: string;
  onClose: () => void;
}

export default function CallOverlay({
  myAddress,
  peerAddress,
  callType,
  userName,
  onClose,
}: CallOverlayProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const callIdRef = useRef<string>("");
  // connectedAtRef tracks when the authenticated join event fired, not when the
  // iframe document loaded. Duration is measured from join to end (#1330).
  const connectedAtRef = useRef<number>(0);
  const startTimeRef = useRef<number>(0);

  useModalFocusTrap(true, dialogRef, onClose);

  useEffect(() => {
    callIdRef.current = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    startTimeRef.current = Date.now();

    saveCallRecord({
      id: callIdRef.current,
      ownerAddress: myAddress.toLowerCase(),
      peerAddress,
      type: callType,
      startedAt: startTimeRef.current,
      status: "ringing",
    });

    // #1330: listen for Daily.co postMessage events instead of iframe onLoad.
    // The `joined-meeting` event fires when the local participant successfully
    // joins the room (not on error pages or waiting screens). `left-meeting`
    // fires when they leave via UI; `error` fires on join failure.
    function handleMessage(ev: MessageEvent) {
      // Daily.co Prebuilt posts events as plain objects with an `action` key.
      if (!ev.data || typeof ev.data !== "object") return;
      const { action } = ev.data as { action?: string };
      if (action === "joined-meeting") {
        connectedAtRef.current = Date.now();
        updateCallRecord(callIdRef.current, myAddress.toLowerCase(), { status: "connected" });
      } else if (action === "left-meeting") {
        const connectedSince = connectedAtRef.current;
        const duration = connectedSince > 0 ? Date.now() - connectedSince : 0;
        updateCallRecord(callIdRef.current, myAddress.toLowerCase(), {
          status: "ended",
          endedAt: Date.now(),
          duration: duration > 0 ? duration : undefined,
        });
        onClose();
      } else if (action === "error") {
        updateCallRecord(callIdRef.current, myAddress.toLowerCase(), { status: "missed" });
      }
    }

    window.addEventListener("message", handleMessage);

    return () => {
      window.removeEventListener("message", handleMessage);
      // If the overlay is closed without a left-meeting event (e.g. browser
      // back), mark as ended with ringing-time duration only when never joined.
      const connectedSince = connectedAtRef.current;
      const endedAt = Date.now();
      const duration = connectedSince > 0 ? endedAt - connectedSince : undefined;
      updateCallRecord(callIdRef.current, myAddress.toLowerCase(), {
        status: connectedSince > 0 ? "ended" : "missed",
        endedAt,
        duration,
      });
    };
  }, [myAddress, peerAddress, callType, onClose]);

  const dailyUrl = getDailyUrl(myAddress, peerAddress, callType, userName);

  // handleIframeLoad is intentionally left as a no-op; the connected state is
  // now driven by the joined-meeting postMessage event (#1330).
  const handleIframeLoad = useCallback(() => {}, []);

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={`${callType === "video" ? "Video" : "Voice"} call`}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <div className="relative w-full max-w-4xl mx-4">
        {/* Controls bar */}
        <div className="absolute -top-12 left-0 right-0 flex items-center justify-between z-10">
          <span className="text-sm text-white/70">
            {callType === "video" ? "Video call" : "Voice call"} with{" "}
            <TruncatedAddress address={peerAddress} className="font-mono text-sm text-white/70" />
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 transition-colors"
              aria-label="End call"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path strokeLinecap="round" d="M3.5 16.5c4.5-4.5 12.5-4.5 17 0M5 14c3.5-3 9.5-3 13 0M6.5 11.5c2.5-2.5 7.5-2.5 10 0" />
              </svg>
              End
            </button>
          </div>
        </div>

       
        <div className="aspect-video w-full overflow-hidden rounded-xl bg-black shadow-2xl">
          <iframe
            src={dailyUrl}
            className="h-full w-full border-0"
            allow="camera; microphone; display-capture; autoplay"
            title={`${callType} call`}
            onLoad={handleIframeLoad}
          />
        </div>
      </div>
    </div>
  );
}
