/**
 * Renders a schema.org payload as a JSON-LD <script>. Server component — the
 * tag ships in SSR HTML so crawlers / AI answer engines read it without JS.
 */
export default function JsonLd({ data }: { data: unknown }) {
    return (
        <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
        />
    );
}
