import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../../src/app.js";
import type { BuildAppOptions } from "../../src/model.js";

const { serve, server } = vi.hoisted(() => {
  const server = {
    address: () => ({ port: 3000 }),
    once: vi.fn(),
    setTimeout: vi.fn(),
  };

  return {
    serve: vi.fn((_options: unknown, onListening: () => void) => {
      queueMicrotask(onListening);

      return server;
    }),
    server,
  };
});

vi.mock("@hono/node-server", () => ({ serve }));

describe("buildApp", () => {
  it("limits connections by inactivity instead of the total request time", async () => {
    const app = await buildApp({ accessToken: "token", secret: "secret" } as BuildAppOptions);

    await app.listen({ host: "127.0.0.1", port: 0 });

    expect(serve).toHaveBeenCalledWith(
      expect.objectContaining({ serverOptions: { headersTimeout: 60_000, requestTimeout: 0 } }),
      expect.any(Function),
    );
    expect(server.setTimeout).toHaveBeenCalledWith(300_000);
  });
});
