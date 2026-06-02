"use client";

import { useEffect } from "react";
import { useAuth } from "@clerk/nextjs";

// First-party first-touch acquisition record. Survives the Clerk sign-up redirect.
const COOKIE = "rioko_attr";
const SYNCED = "rioko_attr_synced"; // localStorage guard so we POST at most once
const MAX_AGE = 90 * 24 * 60 * 60; // 90 days

type Attribution = {
    referrer: string;
    utm_source: string;
    utm_medium: string;
    utm_campaign: string;
    landing: string;
    click_id: string;
};

function readCookie(name: string): string | null {
    const hit = document.cookie
        .split("; ")
        .find((c) => c.startsWith(name + "="));
    return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
}

/** Capture first-touch into the cookie — only if it isn't set yet. */
function captureFirstTouch() {
    if (readCookie(COOKIE)) return; // first-touch wins, never overwrite
    const p = new URLSearchParams(window.location.search);
    const data: Attribution = {
        referrer: document.referrer || "",
        utm_source: p.get("utm_source") || "",
        utm_medium: p.get("utm_medium") || "",
        utm_campaign: p.get("utm_campaign") || "",
        landing: window.location.pathname,
        click_id: p.get("gclid") || p.get("fbclid") || "",
    };
    const value = encodeURIComponent(JSON.stringify(data));
    document.cookie = `${COOKIE}=${value}; path=/; max-age=${MAX_AGE}; SameSite=Lax`;
}

export default function AttributionCapture() {
    const { isSignedIn, isLoaded } = useAuth();

    // Always try to record first-touch on any public page load.
    useEffect(() => {
        captureFirstTouch();
    }, []);

    // Once authenticated, persist the captured attribution to the user record.
    // Server is idempotent (writes only while acq_captured_at IS NULL); the
    // localStorage guard just avoids redundant requests.
    useEffect(() => {
        if (!isLoaded || !isSignedIn) return;
        if (localStorage.getItem(SYNCED)) return;
        const raw = readCookie(COOKIE);
        if (!raw) return;
        let payload: Attribution;
        try {
            payload = JSON.parse(raw);
        } catch {
            return;
        }
        fetch("/api/user/attribution", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            keepalive: true,
        })
            .then(() => localStorage.setItem(SYNCED, "1"))
            .catch(() => { /* retried on next load */ });
    }, [isLoaded, isSignedIn]);

    return null;
}
