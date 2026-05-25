import type { MDXComponents } from "mdx/types";
import Image, { type ImageProps } from "next/image";
import { Link } from "@/i18n/navigation";

/**
 * Global MDX renderers for blog articles. Next.js auto-discovers this file at
 * the project root and applies it to every .mdx imported as a page or
 * component. Styled to match the dark Rioko theme.
 */
export function useMDXComponents(components: MDXComponents): MDXComponents {
    return {
        h1: ({ children, ...props }) => (
            <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight text-fg mt-12 mb-6" {...props}>
                {children}
            </h1>
        ),
        h2: ({ children, ...props }) => (
            <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight text-fg mt-12 mb-4" {...props}>
                {children}
            </h2>
        ),
        h3: ({ children, ...props }) => (
            <h3 className="text-xl font-semibold tracking-tight text-fg mt-8 mb-3" {...props}>
                {children}
            </h3>
        ),
        p: ({ children, ...props }) => (
            <p className="text-base text-fg-80 leading-relaxed mb-5" {...props}>
                {children}
            </p>
        ),
        a: ({ href, children, ...props }) => {
            const isInternal = typeof href === "string" && (href.startsWith("/") || href.startsWith("#"));
            if (isInternal) {
                return (
                    <Link href={href as any} className="text-accent hover:text-accent-hot underline decoration-1 underline-offset-4 transition-colors" {...(props as any)}>
                        {children}
                    </Link>
                );
            }
            return (
                <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent hover:text-accent-hot underline decoration-1 underline-offset-4 transition-colors" {...props}>
                    {children}
                </a>
            );
        },
        ul: ({ children, ...props }) => (
            <ul className="list-disc pl-6 mb-5 space-y-2 text-base text-fg-80 leading-relaxed marker:text-fg-40" {...props}>
                {children}
            </ul>
        ),
        ol: ({ children, ...props }) => (
            <ol className="list-decimal pl-6 mb-5 space-y-2 text-base text-fg-80 leading-relaxed marker:text-fg-40 marker:font-mono marker:text-sm" {...props}>
                {children}
            </ol>
        ),
        li: ({ children, ...props }) => (
            <li className="text-fg-80 leading-relaxed" {...props}>
                {children}
            </li>
        ),
        strong: ({ children, ...props }) => (
            <strong className="font-semibold text-fg" {...props}>
                {children}
            </strong>
        ),
        em: ({ children, ...props }) => (
            <em className="italic text-fg-80" {...props}>
                {children}
            </em>
        ),
        code: ({ children, ...props }) => (
            <code className="font-mono text-[0.9em] bg-surface-2 text-accent px-1.5 py-0.5 rounded-md" {...props}>
                {children}
            </code>
        ),
        pre: ({ children, ...props }) => (
            <pre className="bg-surface-2 border border-hairline rounded-2xl p-4 sm:p-6 my-6 overflow-x-auto text-sm font-mono text-fg" {...props}>
                {children}
            </pre>
        ),
        blockquote: ({ children, ...props }) => (
            <blockquote className="border-l-4 border-accent pl-5 py-2 my-6 italic text-fg-60" {...props}>
                {children}
            </blockquote>
        ),
        table: ({ children, ...props }) => (
            <div className="overflow-x-auto my-6">
                <table className="w-full border-collapse text-sm" {...props}>
                    {children}
                </table>
            </div>
        ),
        thead: ({ children, ...props }) => (
            <thead className="border-b border-hairline" {...props}>
                {children}
            </thead>
        ),
        th: ({ children, ...props }) => (
            <th className="text-left px-4 py-2 font-mono text-[10px] text-fg-40 uppercase tracking-[0.18em]" {...props}>
                {children}
            </th>
        ),
        td: ({ children, ...props }) => (
            <td className="px-4 py-3 border-b border-hairline text-fg-80" {...props}>
                {children}
            </td>
        ),
        hr: (props) => (
            <hr className="border-t border-hairline my-10" {...props} />
        ),
        img: ({ src, alt, ...props }) => {
            if (typeof src !== "string") return null;
            return (
                <span className="block my-8">
                    <Image
                        src={src}
                        alt={alt ?? ""}
                        width={1200}
                        height={675}
                        className="rounded-2xl border border-hairline w-full h-auto"
                        {...(props as Partial<ImageProps>)}
                    />
                    {alt && <span className="block mt-2 text-xs text-fg-40 text-center italic">{alt}</span>}
                </span>
            );
        },
        ...components,
    };
}
