"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown } from "lucide-react";

type FaqItem = { q: string; a: string };

/**
 * Generic FAQ accordion fed by data (not i18n messages), so guide pages can pass
 * their frontmatter `faq`. Carries `data-faq-question` / `data-faq-answer` so the
 * FAQPage `speakable` cssSelector (lib/schema.ts) resolves on these pages too.
 */
export default function FaqAccordion({ items }: { items: FaqItem[] }) {
    const [open, setOpen] = useState<number | null>(0);
    if (!items?.length) return null;

    return (
        <div className="mt-6 max-w-[820px]">
            {items.map((item, i) => {
                const isOpen = open === i;
                return (
                    <div key={i} className="border-t border-hairline first:border-t-0">
                        <button
                            type="button"
                            onClick={() => setOpen(isOpen ? null : i)}
                            aria-expanded={isOpen}
                            className="flex w-full items-center justify-between gap-6 py-5 text-left transition-opacity hover:opacity-90"
                        >
                            <span
                                data-faq-question
                                className="text-[16px] font-medium tracking-tight text-fg sm:text-[18px]"
                            >
                                {item.q}
                            </span>
                            <ChevronDown
                                className="h-5 w-5 shrink-0 text-accent-hot transition-transform duration-300"
                                style={{ transform: isOpen ? "rotate(180deg)" : "none" }}
                                strokeWidth={1.6}
                            />
                        </button>
                        <AnimatePresence initial={false}>
                            {isOpen && (
                                <motion.div
                                    initial={{ height: 0, opacity: 0 }}
                                    animate={{ height: "auto", opacity: 1 }}
                                    exit={{ height: 0, opacity: 0 }}
                                    transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                                    className="overflow-hidden"
                                >
                                    <p
                                        data-faq-answer
                                        className="max-w-[68ch] pb-5 text-[14px] leading-[1.6] text-fg-60"
                                    >
                                        {item.a}
                                    </p>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>
                );
            })}
        </div>
    );
}
