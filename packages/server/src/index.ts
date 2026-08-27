import { createApp, defaultDependencies } from './app.js';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '0.0.0.0';

const dependencies = defaultDependencies();
const app = createApp(dependencies);

const server = app.listen(port, host, () => {
  console.log(`[atp] API listening on http://${host}:${port}`);
  console.log(`[atp] weather provider: ${dependencies.weather.name}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`[atp] ${signal} received, shutting down`);
    server.close(() => process.exit(0));
  });
}
