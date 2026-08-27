import { describe, expect, it } from 'vitest';

import { weatherProviderFromEnv } from './config.js';

describe('weatherProviderFromEnv', () => {
  it('defaults to live weather with the climate model behind it', () => {
    expect(weatherProviderFromEnv({}).name).toBe('open-meteo+synthetic');
  });

  it('runs offline when asked, which is what CI and the demos want', () => {
    expect(weatherProviderFromEnv({ WEATHER_PROVIDER: 'synthetic' }).name).toBe('synthetic');
    expect(weatherProviderFromEnv({ WEATHER_PROVIDER: 'SYNTHETIC' }).name).toBe('synthetic');
  });

  it('ignores an unusable timeout rather than failing to start', () => {
    for (const value of ['', 'soon', '0', '-5']) {
      expect(weatherProviderFromEnv({ WEATHER_TIMEOUT_MS: value }).name).toBe('open-meteo+synthetic');
    }
  });
});
