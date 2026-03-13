import { createClient } from "@hey-api/openapi-ts";

const RESERVED = new Set(["", "api"]); // optional: ignore some segments

function toSegments(operation: any) {
  const segs = operation.path
    .split("?")[0]
    .split("/")
    .filter(Boolean)
    .filter((s) => !RESERVED.has(s))
    .map((s) => {
      // "{petId}" -> "byPetId" (or just "byId" – your preference)
      const m = s.match(/^\{(.+)\}$/);
      if (m) {
        return `by${m[1][0].toUpperCase()}${m[1].slice(1)}`;
      }
      // sanitize for JS identifiers
      return s.replace(/[^\w]/g, "_");
    });

  // add method as leaf to avoid collisions
  segs.push(operation.method.toLowerCase());

  return segs;
}

createClient({
  input: "https://ix-proxy.kapta.app/openapi.json",
  output: "src/api/ix/client",
  plugins: [
    {
      name: "@hey-api/sdk",
      operations: {
        strategy: "single",
        containerName: "IxApi",
        nesting(operation) {
          return toSegments(operation);
        },
      },
    },
  ],
});
