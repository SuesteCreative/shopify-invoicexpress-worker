export const onRequestPost: PagesFunction = async (context) => {
    try {
        const payload = await context.request.json();
        console.log("Received Shopify Webhook:", payload);

        // Business logic will go here

        return new Response(JSON.stringify({ message: "Webhook received" }), {
            headers: { "Content-Type": "application/json" },
            status: 200,
        });
    } catch (error) {
        return new Response(JSON.stringify({ error: "Invalid payload" }), {
            headers: { "Content-Type": "application/json" },
            status: 400,
        });
    }
};
