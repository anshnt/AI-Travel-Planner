import { FallbackWeatherProvider, SyntheticWeatherProvider, type WeatherProvider } from './providers/weather.js';
import { OpenMeteoWeatherProvider } from './providers/open-meteo.js';

/**
 * Which providers to run, from the environment.
 *
 * Live weather is the default because a travel planner that invents the forecast
 * is a toy. `WEATHER_PROVIDER=synthetic` forces the offline model, which is what
 * CI and the demo scripts want: reproducible, and no network.
 */
export function weatherProviderFromEnv(env: NodeJS.ProcessEnv = process.env): WeatherProvider {
  const choice = (env.WEATHER_PROVIDER ?? 'open-meteo').toLowerCase();
  if (choice === 'synthetic') return new SyntheticWeatherProvider();

  const timeoutMs = positiveInt(env.WEATHER_TIMEOUT_MS) ?? undefined;
  return new FallbackWeatherProvider(
    new OpenMeteoWeatherProvider(timeoutMs === undefined ? {} : { timeoutMs }),
    new SyntheticWeatherProvider(),
    (error) => {
      // Logged rather than swallowed: a silently degraded forecast is the kind of
      // thing that goes unnoticed for weeks.
      console.warn(`[atp] live forecast unavailable, using the climate model: ${describe(error)}`);
    },
  );
}

function positiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.name === 'AbortError' ? 'request timed out' : error.message;
  return String(error);
}
