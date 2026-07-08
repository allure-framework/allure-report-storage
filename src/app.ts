import type { ServerType } from "@hono/node-server";
import { serve } from "@hono/node-server";

import type { BuildAppOptions, ListenOptions } from "./model.js";
import type { Repositories } from "./repositories/api.js";
import { createHttpApp } from "./service.js";

const closeRepositories = async (repositories: Repositories): Promise<void> => {
  await Promise.all(Object.values(repositories).map((repository) => repository.close()));
};

const closeServer = async (server: ServerType): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
};

export const buildApp = async (options: BuildAppOptions) => {
  const app = createHttpApp(options);
  let server: ServerType | null = null;

  return {
    close: async () => {
      if (server) {
        const activeServer = server;

        server = null;

        await closeServer(activeServer);
      }

      await closeRepositories(options.repositories);
    },
    fetch: app.fetch,
    listen: async (listenOptions: ListenOptions = {}) => {
      if (server) {
        throw new Error("server is already listening");
      }

      const host = listenOptions.host ?? "0.0.0.0";
      const port = listenOptions.port ?? 3000;

      return await new Promise<string>((resolve, reject) => {
        let resolved = false;

        server = serve(
          {
            fetch: app.fetch,
            hostname: host,
            overrideGlobalObjects: false,
            port,
          },
          () => {
            const address = server?.address();
            const actualPort =
              typeof address === "object" && address !== null && typeof address.port === "number" ? address.port : port;

            resolved = true;

            resolve(`http://${host}:${actualPort}`);
          },
        );

        server.once("error", (error) => {
          if (!resolved) {
            server = null;

            reject(error);
          }
        });
      });
    },
    request: app.request.bind(app),
  };
};

export type { BuildAppOptions, StaticBuildAppOptions } from "./model.js";
