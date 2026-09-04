import { createApp } from "./app.js";
import { config } from "./config.js";

createApp().listen(config.port, () => {
  console.log(`chess server listening on http://localhost:${config.port}`);
});
