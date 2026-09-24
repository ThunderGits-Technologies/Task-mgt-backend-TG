import { createApp } from "./app";
import { config } from "./lib/config";

const app = createApp();

app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`Agency API listening on http://localhost:${config.port}`);
});
