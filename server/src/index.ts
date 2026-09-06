import { createApp } from "./app.js";
import { config } from "./config.js";
import { closeDb, initDb } from "./db.js";

await initDb();

const server = createApp().listen(config.port, () => {
  console.log(`chess server listening on http://localhost:${config.port}`);
});

// Render (and most PaaS) send SIGTERM on deploy/restart. Stop taking requests,
// close the Postgres pool, then exit. Force-exit after 5s so a hung connection
// cannot block the deploy.
let shuttingDown = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${sig} received, shutting down`);
    server.close(async () => {
      await closeDb().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => {
      closeDb()
        .catch(() => {})
        .finally(() => process.exit(0));
    }, 5000).unref();
  });
}
