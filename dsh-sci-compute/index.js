import { defineTool } from "@deepseek-ai/dsh-tools";
import Schema from "@deepseek-ai/schemastery";
import { compute, DEFAULT_CONFIG, sciCatalog } from "./lib/dispatch.js";
import { retain } from "./lib/retain.js";

export const name = "@local/dsh-sci-compute";
export const inject = ["tools"];
export const Config = Schema.object({
  coverageFactor: Schema.number().default(DEFAULT_CONFIG.coverageFactor),
  maxInlineNumbers: Schema.number().default(DEFAULT_CONFIG.maxInlineNumbers),
  maxOutputBytes: Schema.number().default(DEFAULT_CONFIG.maxOutputBytes),
  timeoutMs: Schema.number().default(DEFAULT_CONFIG.timeoutMs),
  monteCarloMaxDraws: Schema.number().default(DEFAULT_CONFIG.monteCarloMaxDraws),
  pythonPath: Schema.string().default(""),
});

export function apply(ctx, config = {}) {
  if (!ctx?.tools?.register) return;
  const cfg = { ...DEFAULT_CONFIG, ...config };
  retain(ctx, () => {
    const stopCatalog = ctx.tools.register(defineTool({
      name: "sci_catalog",
      description: "List scientific operations in the open catalog. Filter by domain and page through results. Unavailable operations stay listed.",
      parameters: {
        domain: { type: "string", description: "Optional domain filter, such as calculus or linear_algebra." },
        offset: { type: "number", description: "Zero-based page offset. Default 0." },
        limit: { type: "number", description: "Page size from 1 to 200. Default 50." },
      },
      output: {
        schema: { type: "string" },
        render: (_args, value) => [{ type: "text", text: value }],
      },
      async execute(args) {
        try {
          return JSON.stringify(await sciCatalog(args ?? {}, cfg));
        } catch (error) {
          return `ERROR: ${error.message}`;
        }
      },
    }));
    const stopCompute = ctx.tools.register(defineTool({
      name: "sci_compute",
      description: "Run one catalog operation. The model chooses the operation and writes the expression; this tool only computes. Results are exact, numeric, or lab. Missing measurements are not filled with instrument nominals.",
      parameters: {
        op: { type: "string", required: true, description: "Operation id from sci_catalog, such as calc.integrate or fit.linear." },
        args: { type: "object", additionalProperties: true, required: true, description: "Arguments matching that operation's argsSchema." },
        mode: { type: "string", description: "Optional exact, numeric, or lab. Overrides the profile default." },
        profile: { type: "string", description: "Optional calculus, linear_algebra, physics_lab, or physics. Sets the default mode and extra checks." },
      },
      output: {
        schema: { type: "string" },
        render: (_args, value) => [{ type: "text", text: value }],
      },
      async execute(args) {
        try {
          return JSON.stringify(await compute(args ?? {}, cfg));
        } catch (error) {
          return `ERROR: ${error.message}`;
        }
      },
    }));
    return () => {
      stopCatalog();
      stopCompute();
    };
  });
}

export { compute, sciCatalog };
