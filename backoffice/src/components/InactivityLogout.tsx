"use client";

import { useClerk } from "@clerk/nextjs";
import { useEffect, useRef } from "react";

const INACTIVITY_LIMIT_MS = 30 * 60 * 1000; // 30 minutes

export default function InactivityLogout() {
    const { signOut } = useClerk();
    const timerRef = useRef<NodeJS.Timeout | null>(null);

    const resetTimer = () => {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
            console.log("Inactivity limit reached. Signing out...");
            signOut({ redirectUrl: "/sign-in" });
        }, INACTIVITY_LIMIT_MS);
    };

    useEffect(() => {
        // Events to watch
        const events = ["mousedown", "mousemove", "keydown", "scroll", "touchstart"];

        // Initial start
        resetTimer();

        // Reset when user is active
        events.forEach((event) => {
            window.addEventListener(event, resetTimer);
        });

        return () => {
            if (timerRef.current) clearTimeout(timerRef.current);
            events.forEach((event) => {
                window.removeEventListener(event, resetTimer);
            });
        };
    }, []);

    return null; // This component doesn't render anything visible
}
